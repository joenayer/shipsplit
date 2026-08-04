/* Projects the real plan into the v2 tables inside an in-memory SQLite, so the schema and the
   projection are checked against each other. Run: node worker/test/project.mjs */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { projectPlan, PROJECTION_TABLES, toMinor, parseDim } from "../src/project.js";

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
db.exec(readFileSync(new URL("../schema-v2.sql", import.meta.url), "utf8"));

const res = [], ck = (n, c) => res.push((c ? "PASS" : "FAIL") + "  " + n);
ck("v2 schema applies cleanly on top of v1", true);

const real = JSON.parse(readFileSync("/workspace/shipsplit-data/plans.json", "utf8"));
const plan = Object.entries(real).filter(([k]) => k !== "__deleted__")[0][1];

// give two shipments invoices: one over, one under
plan.buckets[0].invoice = { number:"FX-88213", date:"2026-07-30", currency:"USD", amount:"1350",
  lines:{freight:"980",fuel:"110",customs:"120",storage:"140"}, status:"received", paidDate:"", notes:"demurrage" };
plan.buckets[1].invoice = { number:"FX-88377", date:"2026-07-31", currency:"USD",
  amount:String(Math.round(Number(plan.buckets[1].quote)*0.91)), lines:{}, status:"paid", paidDate:"2026-08-02", notes:"" };

const AT = 1785000000000;
const ctx = { orgId:"org_1", planId:"plan_1", userId:"u1", at:AT, sourceApp:"shipsplit" };
const { rows, stats } = projectPlan(plan, ctx);

/* insert everything, which validates the rows against the real schema (types, FKs, NOT NULLs) */
db.exec("PRAGMA foreign_keys = ON");
db.prepare("INSERT INTO orgs (id,name,base_currency,weight_unit,volume_unit,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
  .run("org_1","Paper Love","USD","kg","cbm",AT,AT);
db.prepare("INSERT INTO users (id,email,pw_salt,pw_hash,iterations,created_at) VALUES (?,?,?,?,?,?)")
  .run("u1","joel@example.com","s","h",310000,AT);
db.prepare("INSERT INTO plans (id,user_id,name,data,updated_at) VALUES (?,?,?,?,?)")
  .run("plan_1","u1",plan.planName,JSON.stringify(plan),AT);

let inserted = 0;
for (const table of PROJECTION_TABLES) {
  for (const row of rows[table]) {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(()=>"?").join(",")})`)
      .run(...cols.map(c => row[c]));
    inserted++;
  }
}
ck("every projected row inserts against the real schema (" + inserted + " rows)", inserted > 0);

const one = (sql,...p) => db.prepare(sql).get(...p);
const all = (sql,...p) => db.prepare(sql).all(...p);

/* ---- coverage: nothing from the plan is silently dropped ---- */
ck("all 12 products projected", one("SELECT COUNT(*) n FROM plan_products").n === 12);
ck("all 12 SKUs created in the catalog", one("SELECT COUNT(*) n FROM skus").n === 12);
ck("each plan product records the PO it came from",
  one("SELECT COUNT(*) n FROM plan_products WHERE po_text IS NOT NULL").n === 12);
ck("plan-level PO is the fallback when a product has none",
  one("SELECT po_text FROM plan_products LIMIT 1").po_text === plan.po);
ck("all 130 cartons projected", one("SELECT COUNT(*) n FROM cartons").n === 130);
ck("all 4 shipments projected", one("SELECT COUNT(*) n FROM shipments").n === 4);
ck("references carried over", one("SELECT COUNT(*) n FROM shipment_refs").n > 0);
ck("carton dimensions parsed, not just stored as text",
  one("SELECT COUNT(*) n FROM cartons WHERE length_cm IS NOT NULL AND cbm > 0").n === 130);
ck("dim text preserved verbatim alongside the parsed values",
  one("SELECT dim_text FROM cartons LIMIT 1").dim_text === "41x34x33");

/* ---- totals must match the client's own arithmetic ---- */
const planUnits = plan.products.reduce((s,p)=>s+p.cartons.reduce((t,c)=>t+(+c.qty||0),0),0);
ck("carton units total matches the plan (13,040)",
  one("SELECT SUM(qty) s FROM cartons").s === planUnits && planUnits === 13040);
const shipUnits = one("SELECT SUM(units) s FROM shipment_allocations").s;
ck("allocated units equal the sum of shipment rollups",
  shipUnits === one("SELECT SUM(total_units) s FROM shipments").s);
ck("no shipment over-allocates a product",
  all(`SELECT a.plan_product_id, SUM(a.case_count) c FROM shipment_allocations a GROUP BY 1`)
    .every(r => r.c <= one("SELECT COUNT(*) n FROM cartons WHERE plan_product_id=?", r.plan_product_id).n));

/* ---- money is integer minor units everywhere ---- */
const moneyCols = [["freight_quotes","amount_minor"],["invoices","total_minor"],
  ["invoice_lines","amount_minor"],["cost_variances","delta_minor"],["landed_costs","total_minor"]];
ck("every money value stored as an integer", moneyCols.every(([t,c]) =>
  all(`SELECT ${c} v FROM ${t} WHERE ${c} IS NOT NULL`).every(r => Number.isInteger(r.v))));
ck("quote stored in cents (1088 -> 108800)",
  one("SELECT amount_minor m FROM freight_quotes ORDER BY amount_minor DESC LIMIT 1").m > 0 &&
  all("SELECT amount_minor m FROM freight_quotes").some(r => r.m === 108800));

/* ---- invoices + variance ---- */
ck("2 invoices projected", one("SELECT COUNT(*) n FROM invoices").n === 2);
ck("itemised charges projected as lines", one("SELECT COUNT(*) n FROM invoice_lines").n === 4);
ck("invoice lines reference real charge codes",
  one("SELECT COUNT(*) n FROM invoice_lines l LEFT JOIN charge_codes c ON c.code=l.charge_code WHERE c.code IS NULL").n === 0);
const v = one("SELECT * FROM cost_variances WHERE quote_minor=108800");
ck("variance computed: 1088 quoted -> 1350 billed = +262", v && v.delta_minor === 26200);
ck("variance pct stored in micros (~24.08%)", v && Math.abs(v.pct_micros/1e6 - 24.08) < 0.05);
ck("largest charge named as the variance driver", v && v.primary_driver === "freight");
const under = one("SELECT * FROM cost_variances WHERE delta_minor < 0");
ck("an under-budget shipment records a negative delta", !!under);

/* ---- landed cost ---- */
ck("landed cost rows exist for both estimate and actual",
  one("SELECT COUNT(*) n FROM landed_costs WHERE is_estimate=1").n > 0 &&
  one("SELECT COUNT(*) n FROM landed_costs WHERE is_estimate=0").n > 0);
const lcSum = one("SELECT SUM(total_minor) s FROM landed_costs WHERE shipment_id=(SELECT shipment_id FROM cost_variances WHERE quote_minor=108800) AND is_estimate=0").s;
ck("actual landed cost fully allocates the invoice (135000 cents)", Math.abs(lcSum - 135000) <= 12);
const est = one("SELECT SUM(total_minor) s FROM landed_costs WHERE shipment_id=(SELECT shipment_id FROM cost_variances WHERE quote_minor=108800) AND is_estimate=1").s;
ck("estimated landed cost fully allocates the quote (108800 cents)", Math.abs(est - 108800) <= 12);
ck("every landed cost row has a per-unit figure",
  one("SELECT COUNT(*) n FROM landed_costs WHERE unit_cost_minor IS NULL AND units > 0").n === 0);
ck("heavier SKUs carry more freight",
  (()=>{ const r = all(`SELECT lc.total_minor t, a.weight_kg w FROM landed_costs lc
      JOIN shipment_allocations a ON a.shipment_id=lc.shipment_id AND a.plan_product_id=lc.plan_product_id
      WHERE lc.is_estimate=0 ORDER BY a.weight_kg`);
    return r.length>1 && r[0].t <= r[r.length-1].t; })());

/* ---- views answer the questions the schema exists for ---- */
const acc = all("SELECT * FROM quote_accuracy_by_mode");
ck("quote_accuracy_by_mode returns per-mode variance", acc.length > 0 && acc.every(r => r.shipments > 0));
ck("landed cost view returns a current cost per SKU", all("SELECT * FROM sku_landed_cost_current").length > 0);

/* inventory ledger: receiving a shipment produces a balance */
const sku = one("SELECT id FROM skus LIMIT 1").id;
const loc = one("SELECT id FROM locations LIMIT 1").id;
const ins = db.prepare(`INSERT INTO inventory_events (id,org_id,sku_id,location_id,event_type,qty_delta,occurred_at,recorded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
ins.run("ev1","org_1",sku,loc,"received",500,AT,AT,AT);
ins.run("ev2","org_1",sku,loc,"sold",-120,AT,AT,AT);
const bal = one("SELECT qty_on_hand q FROM inventory_balances WHERE sku_id=? AND location_id=?", sku, loc);
ck("inventory balance derives from the event ledger (500-120=380)", bal && bal.q === 380);

/* ---- idempotency: re-projecting must not duplicate ---- */
const again = projectPlan(plan, ctx);
ck("re-projection produces identical ids (safe to run on every save)",
  JSON.stringify(again.rows.shipments.map(r=>r.id)) === JSON.stringify(rows.shipments.map(r=>r.id)) &&
  JSON.stringify(again.rows.cartons.map(r=>r.id)) === JSON.stringify(rows.cartons.map(r=>r.id)));
ck("projection is deterministic across all tables",
  PROJECTION_TABLES.every(t => JSON.stringify(again.rows[t]) === JSON.stringify(rows[t])));

/* ---- edge cases ---- */
ck("empty plan projects without throwing",
  projectPlan({planName:"x",products:[],buckets:[]}, ctx).rows.shipments.length === 0);
ck("malformed dims degrade to zero volume, not NaN", parseDim("not-a-dim").cbm === 0);
ck("blank money is null, not zero", toMinor("") === null && toMinor(null) === null);
ck("money rounds to the cent", toMinor("12.345") === 1235 && toMinor(0.1+0.2) === 30);
ck("a shipment with no quote and no invoice yields no landed cost rows",
  projectPlan({planName:"x",products:[],buckets:[{id:"b",allocations:{},refs:[]}]}, ctx).rows.landed_costs.length === 0);

console.log(res.join("\n"));
console.log("\nProjected rows:", JSON.stringify(stats));
const f = res.filter(x => x.startsWith("FAIL")).length;
console.log(f ? f + " FAILED" : "ALL " + res.length + " CHECKS PASSED");
process.exit(f ? 1 : 0);
