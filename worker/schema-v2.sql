/* ShipSplit unified data model (v2)
   ==================================
   v1 stored each plan as one JSON blob. That is fine for "save my plan" and useless for anything
   else: you cannot ask it what a unit actually cost, how much stock is in AWD, or whether the
   forwarder's quotes are systematically low. This schema decomposes every attribute into rows so the
   data can answer those questions, and so other apps can share it later.

   Design rules, applied everywhere:

   1. ONE TENANT COLUMN, EVERYWHERE. `org_id` on every business table. Today one org per user; when
      apps merge, an org can hold many users without reshaping anything.
   2. EVERY ROW KNOWS WHERE IT CAME FROM. `source_app` + `source_ref` on every table. When the
      inventory app and this app both write a SKU, you can tell which is which and reconcile rather
      than guess. `external_ids` maps our ids to Amazon/QuickBooks/Veeqo/Shopify ids.
   3. MONEY IS INTEGER MINOR UNITS + AN EXPLICIT CURRENCY. Never a float. 12.34 USD is
      (1234, 'USD'). Floats silently lose cents, and a cost system that loses cents is not a cost
      system. Rates keep more precision (see `rate_micros`).
   4. MEASUREMENTS ARE STORED IN ONE UNIT. Metric internally (cm, kg, cbm) exactly like the client
      does today; display units are a UI concern, never a storage concern.
   5. LEDGERS, NOT BALANCES. Inventory is an append-only event log; the balance is a view over it.
      A stored balance drifts the first time two writers disagree, and you can never reconstruct why.
   6. SOFT DELETE + AUDIT. `deleted_at` everywhere, plus `change_log`. A costing system has to be
      able to explain a number that was right last month and different today.
   7. NOTHING IS DESTROYED ON RE-SYNC. Projections are keyed on natural identity, so re-importing a
      plan updates rows instead of orphaning history.

   v1 tables (users, sessions, plans, recovery_codes, login_attempts) stay exactly as they are.
   `plans.data` remains the client's source of truth so the app keeps working unchanged; everything
   below is a queryable projection of it plus the facts the JSON has no room for.
*/

/* ---------------------------------------------------------------------------
   0. Tenancy, provenance, audit
   --------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'USD',   -- what P&L rolls up in
  weight_unit TEXT NOT NULL DEFAULT 'kg',      -- display preference only
  volume_unit TEXT NOT NULL DEFAULT 'cbm',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

/* Which app wrote a row. Populated as apps are folded in ('shipsplit', 'qbo-bridge', 'veeqo', ...) */
CREATE TABLE IF NOT EXISTS source_apps (
  id          TEXT PRIMARY KEY,               -- short slug, e.g. 'shipsplit'
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL DEFAULT 'owner',  -- owner | admin | viewer
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

/* The join table that makes a unified app possible: our id <-> some other system's id.
   entity_type is the table name, so one table covers SKUs, shipments, POs, invoices, everything. */
CREATE TABLE IF NOT EXISTS external_ids (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,                -- 'skus' | 'shipments' | 'invoices' | ...
  entity_id     TEXT NOT NULL,
  system        TEXT NOT NULL,                -- 'amazon' | 'quickbooks' | 'veeqo' | 'shopify' | ...
  external_id   TEXT NOT NULL,
  external_kind TEXT,                         -- 'asin' | 'fnsku' | 'shipment_id' | 'bill_id' | ...
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_external_ids
  ON external_ids (org_id, entity_type, entity_id, system, external_kind, external_id);
CREATE INDEX IF NOT EXISTS ix_external_lookup ON external_ids (org_id, system, external_id);

/* Append-only. Answers "why is this number different from last month". */
CREATE TABLE IF NOT EXISTS change_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,                  -- insert | update | delete
  field       TEXT,                           -- null = whole row
  old_value   TEXT,
  new_value   TEXT,
  actor_user  TEXT,
  source_app  TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_change_entity ON change_log (org_id, entity_type, entity_id, at);

/* ---------------------------------------------------------------------------
   1. Catalog — what a product IS, independent of any one plan
   --------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS suppliers (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  country      TEXT,
  contact      TEXT,
  incoterm     TEXT,                          -- FOB | EXW | DDP | ...
  lead_days    INTEGER,
  notes        TEXT,
  source_app   TEXT, source_ref TEXT,
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_name ON suppliers (org_id, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS skus (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  code            TEXT NOT NULL,              -- 'PL-HTTR-5202-KL' — the operator's identifier
  name            TEXT,
  brand           TEXT,
  category        TEXT,
  supplier_id     TEXT REFERENCES suppliers(id),
  /* customs + compliance: needed for duty, which is part of true landed cost */
  hs_code         TEXT,
  country_of_origin TEXT,
  duty_rate_micros INTEGER,                   -- 6.5% = 65000 (millionths, so fractional % is exact)
  /* per-unit physical facts — carton-level data overrides these when present */
  unit_weight_kg  REAL,
  unit_length_cm  REAL, unit_width_cm REAL, unit_height_cm REAL,
  units_per_case  INTEGER,
  /* commerce */
  uom             TEXT DEFAULT 'each',
  barcode         TEXT,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | discontinued | draft
  notes           TEXT,
  source_app      TEXT, source_ref TEXT,
  created_at      INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sku_code ON skus (org_id, code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_sku_supplier ON skus (org_id, supplier_id);

/* Goods cost, versioned over time. A landed cost computed in March must still reproduce in March
   after the supplier raises prices in May — so cost is never overwritten, only superseded. */
CREATE TABLE IF NOT EXISTS sku_costs (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  sku_id          TEXT NOT NULL REFERENCES skus(id),
  supplier_id     TEXT REFERENCES suppliers(id),
  cost_type       TEXT NOT NULL DEFAULT 'purchase',  -- purchase | tooling | rework | sample
  unit_cost_minor INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  moq             INTEGER,
  valid_from      INTEGER NOT NULL,
  valid_to        INTEGER,                    -- null = current
  source_app      TEXT, source_ref TEXT,
  created_at      INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sku_cost_current ON sku_costs (org_id, sku_id, valid_from, valid_to);

/* ---------------------------------------------------------------------------
   2. Purchasing — the PO the plan is splitting
   --------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  po_number     TEXT NOT NULL,                -- '091 + 092' as typed; see po_number_norm
  po_number_norm TEXT,                        -- lowercased/stripped, for matching across apps
  supplier_id   TEXT REFERENCES suppliers(id),
  status        TEXT NOT NULL DEFAULT 'open', -- draft | open | in_production | shipped | closed
  currency      TEXT NOT NULL DEFAULT 'USD',
  incoterm      TEXT,
  ordered_at    INTEGER,
  ready_date    INTEGER,                      -- factory ready / ex-works
  notes         TEXT,
  source_app    TEXT, source_ref TEXT,
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_po_number ON purchase_orders (org_id, po_number_norm);

CREATE TABLE IF NOT EXISTS po_lines (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  po_id           TEXT NOT NULL REFERENCES purchase_orders(id),
  sku_id          TEXT NOT NULL REFERENCES skus(id),
  qty_ordered     INTEGER NOT NULL,
  qty_received    INTEGER NOT NULL DEFAULT 0,
  unit_cost_minor INTEGER,
  currency        TEXT NOT NULL DEFAULT 'USD',
  created_at      INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_po_lines ON po_lines (org_id, po_id);

/* ---------------------------------------------------------------------------
   3. Planning — the ShipSplit plan, decomposed
   --------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS plan_versions (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  name        TEXT NOT NULL,
  po_id       TEXT REFERENCES purchase_orders(id),
  po_text     TEXT,                           -- as typed, before matching
  ship_from   TEXT,
  ready_date  INTEGER,
  notes       TEXT,
  projected_at INTEGER NOT NULL,              -- when this projection was built from plans.data
  source_app  TEXT, source_ref TEXT,
  created_at  INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_plan_version ON plan_versions (org_id, plan_id);

/* A SKU as it appears in one plan (the client's product row). */
CREATE TABLE IF NOT EXISTS plan_products (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  sku_id       TEXT REFERENCES skus(id),
  client_id    TEXT NOT NULL,                 -- the id inside plans.data, so re-sync is stable
  code         TEXT NOT NULL,
  name         TEXT,
  deadline     INTEGER,                       -- need-by date
  sort_order   INTEGER,
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_product ON plan_products (plan_id, client_id);

/* Every physical case. This is the grain that makes weight/volume costing honest — a plan with
   mixed carton sizes cannot be costed from averages. */
CREATE TABLE IF NOT EXISTS cartons (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  plan_product_id TEXT NOT NULL REFERENCES plan_products(id),
  carton_no       INTEGER NOT NULL,           -- 'n' in the client
  qty             INTEGER NOT NULL,           -- units inside this case
  length_cm       REAL, width_cm REAL, height_cm REAL,
  dim_text        TEXT,                       -- '41x34x33' exactly as typed
  weight_kg       REAL,
  cbm             REAL,                       -- derived, stored so queries stay simple
  note            TEXT,
  created_at      INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_carton ON cartons (plan_product_id, carton_no);

CREATE TABLE IF NOT EXISTS locations (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  code        TEXT NOT NULL,                  -- 'IUSF', 'STAR-...', '3PL-Skillman'
  name        TEXT,
  kind        TEXT NOT NULL,                  -- awd | fba | 3pl | warehouse | supplier | in_transit
  address     TEXT, city TEXT, region TEXT, postal_code TEXT, country TEXT,
  source_app  TEXT, source_ref TEXT,
  created_at  INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_location_code ON locations (org_id, code) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS shipments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  plan_id       TEXT REFERENCES plans(id),
  client_id     TEXT NOT NULL,                -- bucket id inside plans.data
  label         TEXT,
  mode          TEXT,                         -- air | ocean-west | ocean-east | express | ...
  dest_type     TEXT,                         -- awd | fba | fba-split | 3pl | ...
  origin_location_id TEXT REFERENCES locations(id),
  dest_location_id   TEXT REFERENCES locations(id),
  ship_to_text  TEXT,                         -- as typed
  carrier       TEXT,
  status        TEXT NOT NULL DEFAULT 'planned',  -- planned | booked | in-transit | arrived | received
  transit_days  INTEGER,
  /* the full date spine — estimates and actuals side by side, which is what makes a lead-time
     model possible later */
  ready_date    INTEGER,
  booked_date   INTEGER,
  departed_at   INTEGER,
  eta           INTEGER,
  arrived_at    INTEGER,
  received_at   INTEGER,
  /* denormalised rollups, recomputed on projection — cheap reads for dashboards */
  total_cases   INTEGER, total_units INTEGER, total_weight_kg REAL, total_cbm REAL,
  chargeable_kg REAL,                         -- max(actual, volumetric) once a divisor is known
  source_app    TEXT, source_ref TEXT,
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_shipment ON shipments (plan_id, client_id);
CREATE INDEX IF NOT EXISTS ix_shipment_status ON shipments (org_id, status, departed_at);

/* Which cases of which product ride on which shipment. */
CREATE TABLE IF NOT EXISTS shipment_allocations (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  shipment_id     TEXT NOT NULL REFERENCES shipments(id),
  plan_product_id TEXT NOT NULL REFERENCES plan_products(id),
  sku_id          TEXT REFERENCES skus(id),
  case_count      INTEGER NOT NULL,
  units           INTEGER NOT NULL,
  weight_kg       REAL,
  cbm             REAL,
  created_at      INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_alloc ON shipment_allocations (shipment_id, plan_product_id);
CREATE INDEX IF NOT EXISTS ix_alloc_sku ON shipment_allocations (org_id, sku_id);

/* Exactly which physical cases went, when that matters (mixed dims, partial splits). */
CREATE TABLE IF NOT EXISTS shipment_carton_assignments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  shipment_id   TEXT NOT NULL REFERENCES shipments(id),
  carton_id     TEXT NOT NULL REFERENCES cartons(id),
  created_at    INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_carton_assign ON shipment_carton_assignments (shipment_id, carton_id);

CREATE TABLE IF NOT EXISTS shipment_refs (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  ref_type    TEXT NOT NULL,                  -- fba | tracking | bol | container | awb | url
  value       TEXT NOT NULL,
  created_at  INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_refs ON shipment_refs (org_id, shipment_id);
CREATE INDEX IF NOT EXISTS ix_refs_value ON shipment_refs (org_id, value);

/* ---------------------------------------------------------------------------
   4. Money — quotes, invoices, and the gap between them
   --------------------------------------------------------------------------- */

/* Quotes are versioned: forwarders requote, and "what did they originally promise" is the whole
   question. is_selected marks the one the plan is costed against. */
CREATE TABLE IF NOT EXISTS freight_quotes (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  shipment_id   TEXT NOT NULL REFERENCES shipments(id),
  forwarder     TEXT,
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  basis         TEXT,                         -- all_in | per_kg | per_cbm | flat
  rate_micros   INTEGER,                      -- when quoted as a rate: $2.85/kg = 2850000
  transit_days  INTEGER,
  valid_until   INTEGER,
  is_selected   INTEGER NOT NULL DEFAULT 1,
  quoted_at     INTEGER,
  notes         TEXT,
  source_app    TEXT, source_ref TEXT,
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_quote_shipment ON freight_quotes (org_id, shipment_id, is_selected);

CREATE TABLE IF NOT EXISTS charge_codes (
  code        TEXT PRIMARY KEY,               -- freight | fuel | customs | duty | brokerage | ...
  label       TEXT NOT NULL,
  cost_class  TEXT NOT NULL,                  -- freight | duty | handling | penalty | other
  /* how this charge should spread across the SKUs in a shipment when computing landed cost */
  default_allocation TEXT NOT NULL DEFAULT 'weight',  -- weight | volume | units | value | none
  is_capitalised INTEGER NOT NULL DEFAULT 1   -- 1 = belongs in COGS, 0 = period expense
);

CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  shipment_id    TEXT REFERENCES shipments(id),
  vendor         TEXT,                        -- forwarder / broker / carrier
  invoice_number TEXT,
  invoice_date   INTEGER,
  due_date       INTEGER,
  currency       TEXT NOT NULL DEFAULT 'USD',
  total_minor    INTEGER,                     -- as billed, all-in
  lines_total_minor INTEGER,                  -- sum of invoice_lines, for cross-checking
  fx_rate_micros INTEGER,                     -- to org base currency, if different
  status         TEXT NOT NULL DEFAULT 'awaiting', -- awaiting | received | disputed | paid
  paid_date      INTEGER,
  notes          TEXT,
  source_app     TEXT, source_ref TEXT,
  created_at     INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_invoice_shipment ON invoices (org_id, shipment_id);
CREATE INDEX IF NOT EXISTS ix_invoice_status ON invoices (org_id, status, invoice_date);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  invoice_id   TEXT NOT NULL REFERENCES invoices(id),
  charge_code  TEXT REFERENCES charge_codes(code),
  description  TEXT,
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  qty          REAL,
  rate_micros  INTEGER,
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_invoice_lines ON invoice_lines (org_id, invoice_id);

/* The estimate-vs-actual fact, stored rather than recomputed, so history survives a requote. */
CREATE TABLE IF NOT EXISTS cost_variances (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  shipment_id    TEXT NOT NULL REFERENCES shipments(id),
  quote_minor    INTEGER NOT NULL,
  invoiced_minor INTEGER NOT NULL,
  delta_minor    INTEGER NOT NULL,            -- invoiced - quote; positive = over
  pct_micros     INTEGER,                     -- 24.08% = 24080000
  currency       TEXT NOT NULL DEFAULT 'USD',
  primary_driver TEXT,                        -- charge_code contributing most of the overage
  computed_at    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_variance ON cost_variances (shipment_id);

/* ---------------------------------------------------------------------------
   5. True landed cost
   --------------------------------------------------------------------------- */

/* One row per SKU per shipment: what a unit really cost to get there. Every component is kept
   separately, because "landed cost" with no breakdown is a number nobody trusts or can act on.
   `is_estimate` distinguishes a quote-based figure from an invoice-based one — the whole point is
   being able to see both and watch the gap close. */
CREATE TABLE IF NOT EXISTS landed_costs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  sku_id            TEXT REFERENCES skus(id),
  shipment_id       TEXT NOT NULL REFERENCES shipments(id),
  plan_product_id   TEXT REFERENCES plan_products(id),
  units             INTEGER NOT NULL,
  allocation_basis  TEXT NOT NULL,            -- weight | volume | units | value
  allocation_share_micros INTEGER,            -- this SKU's share of the shipment, in millionths
  goods_cost_minor  INTEGER NOT NULL DEFAULT 0,
  freight_minor     INTEGER NOT NULL DEFAULT 0,
  duty_minor        INTEGER NOT NULL DEFAULT 0,
  handling_minor    INTEGER NOT NULL DEFAULT 0,
  other_minor       INTEGER NOT NULL DEFAULT 0,
  total_minor       INTEGER NOT NULL DEFAULT 0,
  unit_cost_minor   INTEGER,                  -- total_minor / units
  currency          TEXT NOT NULL DEFAULT 'USD',
  is_estimate       INTEGER NOT NULL DEFAULT 1,   -- 1 = from quote, 0 = from final invoice
  computed_at       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_landed ON landed_costs (shipment_id, plan_product_id, is_estimate);
CREATE INDEX IF NOT EXISTS ix_landed_sku ON landed_costs (org_id, sku_id, computed_at);

/* ---------------------------------------------------------------------------
   6. Inventory — an append-only ledger, never a stored balance
   --------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS inventory_events (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  sku_id        TEXT NOT NULL REFERENCES skus(id),
  location_id   TEXT REFERENCES locations(id),
  event_type    TEXT NOT NULL,                -- received | shipped | in_transit | adjustment |
                                              -- sold | returned | damaged | transfer_in | transfer_out
  qty_delta     INTEGER NOT NULL,             -- signed: +in, -out
  shipment_id   TEXT REFERENCES shipments(id),
  po_id         TEXT REFERENCES purchase_orders(id),
  unit_cost_minor INTEGER,                    -- cost layer for FIFO/weighted-average later
  currency      TEXT NOT NULL DEFAULT 'USD',
  occurred_at   INTEGER NOT NULL,             -- when it physically happened
  recorded_at   INTEGER NOT NULL,             -- when we learned about it
  reason        TEXT,
  source_app    TEXT, source_ref TEXT,
  created_at    INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_inv_sku ON inventory_events (org_id, sku_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_inv_loc ON inventory_events (org_id, location_id, sku_id);
CREATE INDEX IF NOT EXISTS ix_inv_shipment ON inventory_events (org_id, shipment_id);

/* Current on-hand, derived. Never written to. */
CREATE VIEW IF NOT EXISTS inventory_balances AS
SELECT org_id, sku_id, location_id,
       SUM(qty_delta) AS qty_on_hand,
       MAX(occurred_at) AS last_movement_at
FROM inventory_events
WHERE deleted_at IS NULL
GROUP BY org_id, sku_id, location_id;

/* Latest landed unit cost per SKU, invoice-based preferred over quote-based. */
CREATE VIEW IF NOT EXISTS sku_landed_cost_current AS
SELECT lc.org_id, lc.sku_id,
       lc.unit_cost_minor, lc.currency, lc.is_estimate, lc.computed_at, lc.shipment_id
FROM landed_costs lc
WHERE lc.deleted_at IS NULL
  AND lc.computed_at = (
    SELECT MAX(x.computed_at) FROM landed_costs x
    WHERE x.sku_id = lc.sku_id AND x.org_id = lc.org_id AND x.deleted_at IS NULL
      AND x.is_estimate = (SELECT MIN(y.is_estimate) FROM landed_costs y
                           WHERE y.sku_id = lc.sku_id AND y.org_id = lc.org_id AND y.deleted_at IS NULL)
  );

/* How well the forwarder's quotes track reality, by mode. The reason to keep invoices at all. */
CREATE VIEW IF NOT EXISTS quote_accuracy_by_mode AS
SELECT s.org_id, s.mode,
       COUNT(*)                       AS shipments,
       SUM(v.quote_minor)             AS quoted_minor,
       SUM(v.invoiced_minor)          AS invoiced_minor,
       SUM(v.delta_minor)             AS delta_minor,
       AVG(v.pct_micros) / 1000000.0  AS avg_variance_pct
FROM cost_variances v
JOIN shipments s ON s.id = v.shipment_id
WHERE v.deleted_at IS NULL AND s.deleted_at IS NULL
GROUP BY s.org_id, s.mode;

/* Seed the charge vocabulary. default_allocation encodes the honest default for each: freight
   follows weight, duty follows declared value, storage follows volume. */
INSERT OR IGNORE INTO charge_codes (code, label, cost_class, default_allocation, is_capitalised) VALUES
  ('freight',   'Freight',              'freight',  'weight', 1),
  ('fuel',      'Fuel surcharge',       'freight',  'weight', 1),
  ('customs',   'Customs clearance',    'handling', 'value',  1),
  ('duty',      'Duty / tariffs',       'duty',     'value',  1),
  ('brokerage', 'Brokerage',            'handling', 'value',  1),
  ('lastMile',  'Last mile / delivery', 'freight',  'weight', 1),
  ('storage',   'Storage / demurrage',  'penalty',  'volume', 1),
  ('other',     'Other',                'other',    'weight', 1);
