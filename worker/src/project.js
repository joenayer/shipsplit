/* Project a ShipSplit plan (the client's JSON) into the normalised v2 tables.
 *
 * Pure and synchronous: takes the plan, returns rows. No DB, no clock, no randomness — so it is
 * trivially testable and produces identical output for identical input.
 *
 * Ids are DERIVED from natural keys, not generated. Re-projecting the same plan therefore updates
 * the same rows instead of creating duplicates, which is what makes this safe to run on every save.
 */
"use strict";

/* money: dollars (possibly a string from an <input>) -> integer minor units. Never store floats. */
export function toMinor(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}
export function micros(n) { return isFinite(n) ? Math.round(n * 1000000) : null; }
/* dates: the client stores 'YYYY-MM-DD'; store epoch ms so every table sorts and compares the same */
export function toEpoch(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(String(dateStr) + (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? "T00:00:00Z" : ""));
  return isFinite(t) ? t : null;
}
export function parseDim(dim) {
  const m = String(dim || "").match(/^\s*(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return { l: null, w: null, h: null, cbm: 0 };
  const l = +m[1], w = +m[2], h = +m[3];
  return { l, w, h, cbm: (l * w * h) / 1000000 };
}
const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
/* deterministic, readable, collision-free for our key shapes */
const key = (...parts) => parts.map(p => String(p == null ? "" : p).replace(/\|/g, "%7C")).join("|");

const CHARGE_CODES = ["freight", "fuel", "customs", "duty", "brokerage", "lastMile", "storage", "other"];
/* which SKUs a charge should follow when spreading it across a shipment */
const ALLOCATION_BASIS = {
  freight: "weight", fuel: "weight", lastMile: "weight", other: "weight",
  storage: "volume", customs: "value", duty: "value", brokerage: "value",
};

/**
 * @param plan   the client plan JSON (planName, po, products[], buckets[])
 * @param ctx    { orgId, planId, userId, at, sourceApp }
 * @returns      { rows: {table: [...]}, stats }
 */
export function projectPlan(plan, ctx) {
  const orgId = ctx.orgId, planId = ctx.planId, at = ctx.at;
  const app = ctx.sourceApp || "shipsplit";
  const stamp = { created_at: at, updated_at: at, deleted_at: null };
  const rows = {
    skus: [], locations: [], plan_versions: [], plan_products: [], cartons: [],
    shipments: [], shipment_allocations: [], shipment_carton_assignments: [], shipment_refs: [],
    freight_quotes: [], invoices: [], invoice_lines: [], cost_variances: [], landed_costs: [],
  };

  rows.plan_versions.push(Object.assign({
    id: key("pv", planId), org_id: orgId, plan_id: planId,
    name: plan.planName || "", po_id: null, po_text: plan.po || "",
    ship_from: plan.shipFrom || "", ready_date: toEpoch(plan.readyDate), notes: plan.notes || "",
    projected_at: at, source_app: app, source_ref: planId,
  }, stamp));

  /* ---- products, SKUs, cartons ---- */
  const prodIndex = {};   // client product id -> projected facts
  (plan.products || []).forEach((p, i) => {
    const code = String(p.code || "").trim();
    const skuId = code ? key("sku", orgId, norm(code)) : null;
    if (skuId && !rows.skus.some(s => s.id === skuId)) {
      rows.skus.push(Object.assign({
        id: skuId, org_id: orgId, code, name: p.name || "", brand: null, category: null,
        supplier_id: null, hs_code: null, country_of_origin: null, duty_rate_micros: null,
        unit_weight_kg: null, unit_length_cm: null, unit_width_cm: null, unit_height_cm: null,
        units_per_case: null, uom: "each", barcode: null, status: "active", notes: null,
        source_app: app, source_ref: p.id,
      }, stamp));
    }
    const ppId = key("pp", planId, p.id);
    rows.plan_products.push(Object.assign({
      id: ppId, org_id: orgId, plan_id: planId, sku_id: skuId, client_id: p.id,
      code, name: p.name || "", deadline: toEpoch(p.deadline), sort_order: i,
    }, stamp));

    let units = 0, kg = 0, cbm = 0;
    const cartonIds = [];
    (p.cartons || []).forEach((c, ci) => {
      const d = parseDim(c.dim);
      const cId = key("ct", ppId, c.n != null ? c.n : ci);
      cartonIds.push(cId);
      units += Number(c.qty) || 0;
      kg += Number(c.kg) || 0;
      cbm += d.cbm;
      rows.cartons.push(Object.assign({
        id: cId, org_id: orgId, plan_product_id: ppId,
        carton_no: c.n != null ? c.n : ci + 1, qty: Number(c.qty) || 0,
        length_cm: d.l, width_cm: d.w, height_cm: d.h, dim_text: c.dim || "",
        weight_kg: Number(c.kg) || 0, cbm: d.cbm, note: c.note || "",
      }, stamp));
    });
    // per-unit facts inferred from the cases, so the catalog is useful even before anyone fills it in
    const sku = rows.skus.find(s => s.id === skuId);
    if (sku && units > 0) {
      if (sku.unit_weight_kg == null) sku.unit_weight_kg = kg / units;
      const first = (p.cartons || [])[0];
      if (first && sku.units_per_case == null) sku.units_per_case = Number(first.qty) || null;
    }
    prodIndex[p.id] = { ppId, skuId, cartons: p.cartons || [], cartonIds, units, kg, cbm };
  });

  /* ---- shipments ---- */
  (plan.buckets || []).forEach(b => {
    const shipId = key("sh", planId, b.id);
    const shipTo = String(b.shipTo || "").trim();
    let destLocId = null;
    if (shipTo) {
      destLocId = key("loc", orgId, norm(shipTo));
      if (!rows.locations.some(l => l.id === destLocId)) {
        rows.locations.push(Object.assign({
          id: destLocId, org_id: orgId, code: shipTo, name: shipTo,
          kind: b.destType === "awd" ? "awd" : /^fba/.test(b.destType || "") ? "fba" : "3pl",
          address: null, city: null, region: null, postal_code: null, country: null,
          source_app: app, source_ref: b.id,
        }, stamp));
      }
    }

    /* rollups over what is actually allocated to this shipment */
    let cases = 0, units = 0, kg = 0, cbm = 0;
    const allocs = [];
    Object.keys(b.allocations || {}).forEach(pid => {
      const n = Number(b.allocations[pid]) || 0;
      const pi = prodIndex[pid];
      if (!n || !pi) return;
      // the first n cases of that product, matching how the client slices them
      const slice = pi.cartons.slice(0, n);
      const aUnits = slice.reduce((s, c) => s + (Number(c.qty) || 0), 0);
      const aKg = slice.reduce((s, c) => s + (Number(c.kg) || 0), 0);
      const aCbm = slice.reduce((s, c) => s + parseDim(c.dim).cbm, 0);
      cases += n; units += aUnits; kg += aKg; cbm += aCbm;
      allocs.push({ pid, pi, n, aUnits, aKg, aCbm });
      rows.shipment_allocations.push(Object.assign({
        id: key("al", shipId, pi.ppId), org_id: orgId, shipment_id: shipId,
        plan_product_id: pi.ppId, sku_id: pi.skuId,
        case_count: n, units: aUnits, weight_kg: aKg, cbm: aCbm,
      }, stamp));
      pi.cartonIds.slice(0, n).forEach(cId => {
        rows.shipment_carton_assignments.push({
          id: key("ca", shipId, cId), org_id: orgId, shipment_id: shipId,
          carton_id: cId, created_at: at, deleted_at: null,
        });
      });
    });

    const dep = toEpoch(b.depDate);
    const transit = Number(b.transit) || null;
    rows.shipments.push(Object.assign({
      id: shipId, org_id: orgId, plan_id: planId, client_id: b.id,
      label: b.label || "", mode: b.mode || "", dest_type: b.destType || "",
      origin_location_id: null, dest_location_id: destLocId, ship_to_text: shipTo,
      carrier: b.carrier || "", status: b.status || "planned", transit_days: transit,
      ready_date: toEpoch(plan.readyDate), booked_date: null,
      departed_at: dep,
      eta: dep && transit ? dep + transit * 86400000 : null,
      arrived_at: toEpoch(b.arrDate), received_at: b.status === "received" ? toEpoch(b.arrDate) : null,
      total_cases: cases, total_units: units, total_weight_kg: kg, total_cbm: cbm,
      chargeable_kg: null,
      source_app: app, source_ref: b.id,
    }, stamp));

    (b.refs || []).forEach((r, i) => {
      if (!r || !r.value) return;
      rows.shipment_refs.push(Object.assign({
        id: key("rf", shipId, i), org_id: orgId, shipment_id: shipId,
        ref_type: r.type || "tracking", value: String(r.value),
      }, stamp));
    });

    /* ---- estimate: freight quote, plus customs and duty forecast separately ---- */
    const freightMinor = toMinor(b.quote);
    const estCustomsMinor = toMinor(b.estCustoms);
    const estDutyMinor = toMinor(b.estDuty);
    const quoteMinor = (freightMinor || 0) + (estCustomsMinor || 0) + (estDutyMinor || 0) || null;
    if (quoteMinor != null && quoteMinor > 0) {
      rows.freight_quotes.push(Object.assign({
        id: key("fq", shipId), org_id: orgId, shipment_id: shipId,
        forwarder: b.carrier || null, amount_minor: quoteMinor, currency: "USD",
        basis: (estCustomsMinor || estDutyMinor) ? "all_in_with_duty" : "all_in",
        rate_micros: null, transit_days: transit, valid_until: null,
        is_selected: 1, quoted_at: null, notes: null, source_app: app, source_ref: b.id,
      }, stamp));
    }

    /* ---- invoice ---- */
    const inv = b.invoice || {};
    /* charges are a list the operator adds to. Older plans stored a fixed object of every possible
       fee; read either shape so nothing saved before this change is lost. */
    const rawCharges = Array.isArray(inv.charges)
      ? inv.charges.map(c => ({ code: c && c.code, minor: toMinor(c && c.amount) }))
      : CHARGE_CODES.map(code => ({ code, minor: toMinor((inv.lines || {})[code]) }));
    const lineEntries = rawCharges.filter(x => x.code && x.minor != null && x.minor !== 0);
    const linesTotal = lineEntries.reduce((s, x) => s + x.minor, 0);
    const allIn = toMinor(inv.amount);
    const billed = (allIn != null && allIn > 0) ? allIn : (linesTotal > 0 ? linesTotal : null);
    const hasInvoice = billed != null || inv.number || (inv.status && inv.status !== "awaiting");

    if (hasInvoice) {
      const invId = key("in", shipId);
      rows.invoices.push(Object.assign({
        id: invId, org_id: orgId, shipment_id: shipId, vendor: b.carrier || null,
        invoice_number: inv.number || null, invoice_date: toEpoch(inv.date), due_date: null,
        currency: inv.currency || "USD", total_minor: billed,
        lines_total_minor: linesTotal > 0 ? linesTotal : null, fx_rate_micros: null,
        status: inv.status || "received", paid_date: toEpoch(inv.paidDate),
        notes: inv.notes || null, source_app: app, source_ref: b.id,
      }, stamp));
      lineEntries.forEach(x => {
        rows.invoice_lines.push(Object.assign({
          id: key("il", invId, x.code), org_id: orgId, invoice_id: invId,
          charge_code: x.code, description: null, amount_minor: x.minor,
          currency: inv.currency || "USD", qty: null, rate_micros: null,
        }, stamp));
      });

      /* ---- variance ---- */
      if (quoteMinor != null && quoteMinor > 0 && billed != null) {
        const delta = billed - quoteMinor;
        // name the charge that moved the number most, so an overage is actionable, not just red
        let driver = null, best = 0;
        lineEntries.forEach(x => { if (Math.abs(x.minor) > best) { best = Math.abs(x.minor); driver = x.code; } });
        rows.cost_variances.push(Object.assign({
          id: key("cv", shipId), org_id: orgId, shipment_id: shipId,
          quote_minor: quoteMinor, invoiced_minor: billed, delta_minor: delta,
          pct_micros: micros((delta / quoteMinor) * 100), currency: inv.currency || "USD",
          primary_driver: driver, computed_at: at,
        }, stamp));
      }
    }

    /* ---- landed cost per SKU on this shipment ----
       Spread the shipment's cost over its SKUs. Two rows per SKU are possible: the estimate (from
       the quote) and the actual (from the invoice), so the gap stays visible instead of the actual
       quietly overwriting what was planned. Goods cost stays 0 until sku_costs is populated —
       recorded as a component so it can be filled in later without reshaping the row. */
    const basisTotals = { weight: kg, volume: cbm, units: units, value: units };
    const emit = (totalMinor, isEstimate, breakdown) => {
      if (totalMinor == null || totalMinor <= 0 || !allocs.length) return;
      allocs.forEach(a => {
        const share = shareOf(a, basisTotals, breakdown);
        const freight = Math.round((breakdown.freight || 0) * share);
        const duty = Math.round((breakdown.duty || 0) * share);
        const handling = Math.round((breakdown.handling || 0) * share);
        const other = Math.round((breakdown.other || 0) * share);
        const total = freight + duty + handling + other;
        rows.landed_costs.push(Object.assign({
          id: key("lc", shipId, a.pi.ppId, isEstimate ? "est" : "act"),
          org_id: orgId, sku_id: a.pi.skuId, shipment_id: shipId, plan_product_id: a.pi.ppId,
          units: a.aUnits, allocation_basis: "weight",
          allocation_share_micros: micros(share * 100),
          goods_cost_minor: 0, freight_minor: freight, duty_minor: duty,
          handling_minor: handling, other_minor: other, total_minor: total,
          unit_cost_minor: a.aUnits ? Math.round(total / a.aUnits) : null,
          currency: inv.currency || "USD", is_estimate: isEstimate ? 1 : 0, computed_at: at,
        }, stamp));
      });
    };
    if (quoteMinor != null && quoteMinor > 0) {
      emit(quoteMinor, true, {
        freight: freightMinor || 0,
        duty: estDutyMinor || 0,
        handling: estCustomsMinor || 0,
        other: 0,
      });
    }
    if (billed != null && billed > 0) {
      // use the itemised split when it exists; otherwise the whole invoice behaves as freight
      const bd = { freight: 0, duty: 0, handling: 0, other: 0 };
      if (lineEntries.length) {
        lineEntries.forEach(x => {
          const cls = x.code === "duty" ? "duty"
            : (x.code === "customs" || x.code === "brokerage") ? "handling"
            : (x.code === "storage" || x.code === "other") ? "other" : "freight";
          bd[cls] += x.minor;
        });
        // an all-in total larger than the itemised lines means unitemised charges; don't lose them
        const gap = billed - linesTotal;
        if (gap > 0) bd.other += gap;
      } else {
        bd.freight = billed;
      }
      emit(billed, false, bd);
    }
  });

  return {
    rows,
    stats: Object.keys(rows).reduce((o, t) => (o[t] = rows[t].length, o), {}),
  };
}

/* A SKU's share of a shipment, on the basis that fits the dominant charge. Falls back down the
   chain (weight -> volume -> units -> equal split) so a plan with missing weights still costs. */
function shareOf(a, totals, breakdown) {
  const dutyHeavy = (breakdown.duty || 0) > (breakdown.freight || 0);
  if (dutyHeavy && totals.units > 0) return a.aUnits / totals.units;
  if (totals.weight > 0) return a.aKg / totals.weight;
  if (totals.volume > 0) return a.aCbm / totals.volume;
  if (totals.units > 0) return a.aUnits / totals.units;
  return 0;
}

export const PROJECTION_TABLES = [
  "skus", "locations", "plan_versions", "plan_products", "cartons",
  "shipments", "shipment_allocations", "shipment_carton_assignments", "shipment_refs",
  "freight_quotes", "invoices", "invoice_lines", "cost_variances", "landed_costs",
];
export { ALLOCATION_BASIS, CHARGE_CODES };
