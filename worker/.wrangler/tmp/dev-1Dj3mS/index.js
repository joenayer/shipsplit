var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/project.js
function toMinor(value) {
  if (value === "" || value === null || value === void 0) return null;
  const n = Number(value);
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}
__name(toMinor, "toMinor");
function micros(n) {
  return isFinite(n) ? Math.round(n * 1e6) : null;
}
__name(micros, "micros");
function toEpoch(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(String(dateStr) + (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? "T00:00:00Z" : ""));
  return isFinite(t) ? t : null;
}
__name(toEpoch, "toEpoch");
function parseDim(dim) {
  const m = String(dim || "").match(/^\s*(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return { l: null, w: null, h: null, cbm: 0 };
  const l = +m[1], w = +m[2], h = +m[3];
  return { l, w, h, cbm: l * w * h / 1e6 };
}
__name(parseDim, "parseDim");
var norm = /* @__PURE__ */ __name((s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " "), "norm");
var key = /* @__PURE__ */ __name((...parts) => parts.map((p) => String(p == null ? "" : p).replace(/\|/g, "%7C")).join("|"), "key");
var CHARGE_CODES = ["freight", "fuel", "customs", "duty", "brokerage", "lastMile", "storage", "other"];
function projectPlan(plan, ctx) {
  const orgId = ctx.orgId, planId = ctx.planId, at = ctx.at;
  const app = ctx.sourceApp || "shipsplit";
  const stamp = { created_at: at, updated_at: at, deleted_at: null };
  const rows = {
    skus: [],
    locations: [],
    plan_versions: [],
    plan_products: [],
    cartons: [],
    shipments: [],
    shipment_allocations: [],
    shipment_carton_assignments: [],
    shipment_refs: [],
    freight_quotes: [],
    invoices: [],
    invoice_lines: [],
    cost_variances: [],
    landed_costs: []
  };
  rows.plan_versions.push(Object.assign({
    id: key("pv", planId),
    org_id: orgId,
    plan_id: planId,
    name: plan.planName || "",
    po_id: null,
    po_text: plan.po || "",
    ship_from: plan.shipFrom || "",
    ready_date: toEpoch(plan.readyDate),
    notes: plan.notes || "",
    projected_at: at,
    source_app: app,
    source_ref: planId
  }, stamp));
  const prodIndex = {};
  (plan.products || []).forEach((p, i) => {
    const code = String(p.code || "").trim();
    const skuId = code ? key("sku", orgId, norm(code)) : null;
    if (skuId && !rows.skus.some((s) => s.id === skuId)) {
      rows.skus.push(Object.assign({
        id: skuId,
        org_id: orgId,
        code,
        name: p.name || "",
        brand: null,
        category: null,
        supplier_id: null,
        hs_code: null,
        country_of_origin: null,
        duty_rate_micros: null,
        unit_weight_kg: null,
        unit_length_cm: null,
        unit_width_cm: null,
        unit_height_cm: null,
        units_per_case: null,
        uom: "each",
        barcode: null,
        status: "active",
        notes: null,
        source_app: app,
        source_ref: p.id
      }, stamp));
    }
    const ppId = key("pp", planId, p.id);
    rows.plan_products.push(Object.assign({
      id: ppId,
      org_id: orgId,
      plan_id: planId,
      sku_id: skuId,
      client_id: p.id,
      code,
      name: p.name || "",
      // the product's own PO, falling back to the plan's — a plan can cover several orders
      po_text: String(p.po || plan.po || "").trim() || null,
      deadline: toEpoch(p.deadline),
      sort_order: i
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
        id: cId,
        org_id: orgId,
        plan_product_id: ppId,
        carton_no: c.n != null ? c.n : ci + 1,
        qty: Number(c.qty) || 0,
        length_cm: d.l,
        width_cm: d.w,
        height_cm: d.h,
        dim_text: c.dim || "",
        weight_kg: Number(c.kg) || 0,
        cbm: d.cbm,
        note: c.note || ""
      }, stamp));
    });
    const sku = rows.skus.find((s) => s.id === skuId);
    if (sku && units > 0) {
      if (sku.unit_weight_kg == null) sku.unit_weight_kg = kg / units;
      const first = (p.cartons || [])[0];
      if (first && sku.units_per_case == null) sku.units_per_case = Number(first.qty) || null;
    }
    prodIndex[p.id] = { ppId, skuId, cartons: p.cartons || [], cartonIds, units, kg, cbm };
  });
  (plan.buckets || []).forEach((b) => {
    const shipId = key("sh", planId, b.id);
    const shipTo = String(b.shipTo || "").trim();
    let destLocId = null;
    if (shipTo) {
      destLocId = key("loc", orgId, norm(shipTo));
      if (!rows.locations.some((l) => l.id === destLocId)) {
        rows.locations.push(Object.assign({
          id: destLocId,
          org_id: orgId,
          code: shipTo,
          name: shipTo,
          kind: b.destType === "awd" ? "awd" : /^fba/.test(b.destType || "") ? "fba" : "3pl",
          address: null,
          city: null,
          region: null,
          postal_code: null,
          country: null,
          source_app: app,
          source_ref: b.id
        }, stamp));
      }
    }
    let cases = 0, units = 0, kg = 0, cbm = 0;
    const allocs = [];
    Object.keys(b.allocations || {}).forEach((pid) => {
      const n = Number(b.allocations[pid]) || 0;
      const pi = prodIndex[pid];
      if (!n || !pi) return;
      const slice = pi.cartons.slice(0, n);
      const aUnits = slice.reduce((s, c) => s + (Number(c.qty) || 0), 0);
      const aKg = slice.reduce((s, c) => s + (Number(c.kg) || 0), 0);
      const aCbm = slice.reduce((s, c) => s + parseDim(c.dim).cbm, 0);
      cases += n;
      units += aUnits;
      kg += aKg;
      cbm += aCbm;
      allocs.push({ pid, pi, n, aUnits, aKg, aCbm });
      rows.shipment_allocations.push(Object.assign({
        id: key("al", shipId, pi.ppId),
        org_id: orgId,
        shipment_id: shipId,
        plan_product_id: pi.ppId,
        sku_id: pi.skuId,
        case_count: n,
        units: aUnits,
        weight_kg: aKg,
        cbm: aCbm
      }, stamp));
      pi.cartonIds.slice(0, n).forEach((cId) => {
        rows.shipment_carton_assignments.push({
          id: key("ca", shipId, cId),
          org_id: orgId,
          shipment_id: shipId,
          carton_id: cId,
          created_at: at,
          deleted_at: null
        });
      });
    });
    const dep = toEpoch(b.depDate);
    const transit = Number(b.transit) || null;
    rows.shipments.push(Object.assign({
      id: shipId,
      org_id: orgId,
      plan_id: planId,
      client_id: b.id,
      label: b.label || "",
      mode: b.mode || "",
      dest_type: b.destType || "",
      origin_location_id: null,
      dest_location_id: destLocId,
      ship_to_text: shipTo,
      carrier: b.carrier || "",
      status: b.status || "planned",
      transit_days: transit,
      ready_date: toEpoch(plan.readyDate),
      booked_date: null,
      departed_at: dep,
      eta: dep && transit ? dep + transit * 864e5 : null,
      arrived_at: toEpoch(b.arrDate),
      received_at: b.status === "received" ? toEpoch(b.arrDate) : null,
      total_cases: cases,
      total_units: units,
      total_weight_kg: kg,
      total_cbm: cbm,
      // what the carrier actually billed on, when the invoice states it (already metric on the wire)
      chargeable_kg: b.invoice && b.invoice.billedKg !== "" && b.invoice.billedKg != null && isFinite(Number(b.invoice.billedKg)) ? Number(b.invoice.billedKg) : null,
      source_app: app,
      source_ref: b.id
    }, stamp));
    (b.refs || []).forEach((r, i) => {
      if (!r || !r.value) return;
      rows.shipment_refs.push(Object.assign({
        id: key("rf", shipId, i),
        org_id: orgId,
        shipment_id: shipId,
        ref_type: r.type || "tracking",
        value: String(r.value)
      }, stamp));
    });
    const freightMinor = toMinor(b.quote);
    const estCustomsMinor = toMinor(b.estCustoms);
    const estDutyMinor = toMinor(b.estDuty);
    const quoteMinor = (freightMinor || 0) + (estCustomsMinor || 0) + (estDutyMinor || 0) || null;
    if (quoteMinor != null && quoteMinor > 0) {
      rows.freight_quotes.push(Object.assign({
        id: key("fq", shipId),
        org_id: orgId,
        shipment_id: shipId,
        forwarder: b.carrier || null,
        amount_minor: quoteMinor,
        currency: "USD",
        basis: estCustomsMinor || estDutyMinor ? "all_in_with_duty" : "all_in",
        rate_micros: null,
        transit_days: transit,
        valid_until: null,
        is_selected: 1,
        quoted_at: null,
        notes: null,
        source_app: app,
        source_ref: b.id
      }, stamp));
    }
    const inv = b.invoice || {};
    const rawCharges = Array.isArray(inv.charges) ? inv.charges.map((c) => ({ code: c && c.code, minor: toMinor(c && c.amount) })) : CHARGE_CODES.map((code) => ({ code, minor: toMinor((inv.lines || {})[code]) }));
    const lineEntries = rawCharges.filter((x) => x.code && x.minor != null && x.minor !== 0);
    const linesTotal = lineEntries.reduce((s, x) => s + x.minor, 0);
    const allIn = toMinor(inv.amount);
    const billed = allIn != null && allIn > 0 ? allIn : linesTotal > 0 ? linesTotal : null;
    const hasInvoice = billed != null || inv.number || inv.status && inv.status !== "awaiting";
    if (hasInvoice) {
      const invId = key("in", shipId);
      rows.invoices.push(Object.assign({
        id: invId,
        org_id: orgId,
        shipment_id: shipId,
        vendor: b.carrier || null,
        invoice_number: inv.number || null,
        invoice_date: toEpoch(inv.date),
        due_date: null,
        currency: inv.currency || "USD",
        total_minor: billed,
        lines_total_minor: linesTotal > 0 ? linesTotal : null,
        fx_rate_micros: null,
        status: inv.status || "received",
        paid_date: toEpoch(inv.paidDate),
        notes: inv.notes || null,
        source_app: app,
        source_ref: b.id
      }, stamp));
      lineEntries.forEach((x) => {
        rows.invoice_lines.push(Object.assign({
          id: key("il", invId, x.code),
          org_id: orgId,
          invoice_id: invId,
          charge_code: x.code,
          description: null,
          amount_minor: x.minor,
          currency: inv.currency || "USD",
          qty: null,
          rate_micros: null
        }, stamp));
      });
      if (quoteMinor != null && quoteMinor > 0 && billed != null) {
        const delta = billed - quoteMinor;
        let driver = null, best = 0;
        lineEntries.forEach((x) => {
          if (Math.abs(x.minor) > best) {
            best = Math.abs(x.minor);
            driver = x.code;
          }
        });
        rows.cost_variances.push(Object.assign({
          id: key("cv", shipId),
          org_id: orgId,
          shipment_id: shipId,
          quote_minor: quoteMinor,
          invoiced_minor: billed,
          delta_minor: delta,
          pct_micros: micros(delta / quoteMinor * 100),
          currency: inv.currency || "USD",
          primary_driver: driver,
          computed_at: at
        }, stamp));
      }
    }
    const basisTotals = { weight: kg, volume: cbm, units, value: units };
    const emit = /* @__PURE__ */ __name((totalMinor, isEstimate, breakdown) => {
      if (totalMinor == null || totalMinor <= 0 || !allocs.length) return;
      allocs.forEach((a) => {
        const share = shareOf(a, basisTotals, breakdown);
        const freight = Math.round((breakdown.freight || 0) * share);
        const duty = Math.round((breakdown.duty || 0) * share);
        const handling = Math.round((breakdown.handling || 0) * share);
        const other = Math.round((breakdown.other || 0) * share);
        const total = freight + duty + handling + other;
        rows.landed_costs.push(Object.assign({
          id: key("lc", shipId, a.pi.ppId, isEstimate ? "est" : "act"),
          org_id: orgId,
          sku_id: a.pi.skuId,
          shipment_id: shipId,
          plan_product_id: a.pi.ppId,
          units: a.aUnits,
          allocation_basis: "weight",
          allocation_share_micros: micros(share * 100),
          goods_cost_minor: 0,
          freight_minor: freight,
          duty_minor: duty,
          handling_minor: handling,
          other_minor: other,
          total_minor: total,
          unit_cost_minor: a.aUnits ? Math.round(total / a.aUnits) : null,
          currency: inv.currency || "USD",
          is_estimate: isEstimate ? 1 : 0,
          computed_at: at
        }, stamp));
      });
    }, "emit");
    if (quoteMinor != null && quoteMinor > 0) {
      emit(quoteMinor, true, {
        freight: freightMinor || 0,
        duty: estDutyMinor || 0,
        handling: estCustomsMinor || 0,
        other: 0
      });
    }
    if (billed != null && billed > 0) {
      const bd = { freight: 0, duty: 0, handling: 0, other: 0 };
      if (lineEntries.length) {
        lineEntries.forEach((x) => {
          const cls = x.code === "duty" ? "duty" : x.code === "customs" || x.code === "brokerage" ? "handling" : x.code === "storage" || x.code === "other" ? "other" : "freight";
          bd[cls] += x.minor;
        });
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
    stats: Object.keys(rows).reduce((o, t) => (o[t] = rows[t].length, o), {})
  };
}
__name(projectPlan, "projectPlan");
function shareOf(a, totals, breakdown) {
  const dutyHeavy = (breakdown.duty || 0) > (breakdown.freight || 0);
  if (dutyHeavy && totals.units > 0) return a.aUnits / totals.units;
  if (totals.weight > 0) return a.aKg / totals.weight;
  if (totals.volume > 0) return a.aCbm / totals.volume;
  if (totals.units > 0) return a.aUnits / totals.units;
  return 0;
}
__name(shareOf, "shareOf");
var PROJECTION_TABLES = [
  "skus",
  "locations",
  "plan_versions",
  "plan_products",
  "cartons",
  "shipments",
  "shipment_allocations",
  "shipment_carton_assignments",
  "shipment_refs",
  "freight_quotes",
  "invoices",
  "invoice_lines",
  "cost_variances",
  "landed_costs"
];

// src/index.js
var ALLOWED_ORIGINS = [
  "https://shipsplit.joel-036.workers.dev",
  // the app served from this Worker (same origin)
  "https://joenayer.github.io",
  // GitHub Pages, kept working during the switchover
  "http://localhost:8788",
  "http://127.0.0.1:8788"
];
function originAllowed(origin, req) {
  if (origin) return ALLOWED_ORIGINS.includes(origin);
  const site = req.headers.get("Sec-Fetch-Site");
  return site === "same-origin" || site === "none";
}
__name(originAllowed, "originAllowed");
var PBKDF2_MAX_ITERATIONS = 1e5;
var PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
var SESSION_DAYS = 30;
var MAX_FAILED = 10;
var FAIL_WINDOW_MS = 15 * 6e4;
var MAX_FAILED_EMAIL = 50;
var MAX_SIGNUPS_PER_IP = 5;
var MAX_PLAN_BYTES = 2 * 1024 * 1024;
var MAX_PLAN_DEPTH = 32;
var MAX_FILE_BYTES = 25 * 1024 * 1024;
var FILE_KINDS = ["invoice", "label", "packing_list", "bol", "customs_doc", "quote", "photo", "other"];
var SAFE_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip"
];
var enc = new TextEncoder();
var now = /* @__PURE__ */ __name(() => Date.now(), "now");
var uid = /* @__PURE__ */ __name(() => crypto.randomUUID(), "uid");
var b64 = /* @__PURE__ */ __name((buf) => btoa(String.fromCharCode(...new Uint8Array(buf))), "b64");
function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Vary": "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function json(data, status, origin, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      corsHeaders(origin),
      extraHeaders || {}
    )
  });
}
__name(json, "json");
async function sha256b64(str) {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}
__name(sha256b64, "sha256b64");
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
async function pbkdf2(password, saltB64, iterations) {
  const iters = Math.min(Number(iterations) || PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS);
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key2 = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" }, key2, 256);
  return b64(bits);
}
__name(pbkdf2, "pbkdf2");
function randomB64(bytes) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)));
}
__name(randomB64, "randomB64");
function randomToken(bytes) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(randomToken, "randomToken");
function recoveryCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += alphabet[raw[i] % alphabet.length];
    if (i % 4 === 3 && i !== 15) out += "-";
  }
  return out;
}
__name(recoveryCode, "recoveryCode");
function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}
__name(normEmail, "normEmail");
function sessionCookie(token, maxAgeSec) {
  const parts = [
    "ss_session=" + token,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None",
    // the page lives on github.io, the API on workers.dev
    "Max-Age=" + maxAgeSec
  ];
  return parts.join("; ");
}
__name(sessionCookie, "sessionCookie");
function readCookie(req, name) {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
__name(readCookie, "readCookie");
async function currentUser(req, env) {
  const token = readCookie(req, "ss_session");
  if (!token) return null;
  const hash = await sha256b64(token);
  const row = await env.DB.prepare(
    "SELECT s.id AS sid, s.expires_at, u.id AS uid, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(hash).first();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.sid).run();
    return null;
  }
  return { id: row.uid, email: row.email, sessionId: row.sid };
}
__name(currentUser, "currentUser");
async function startSession(env, userId) {
  const token = randomToken(32);
  const expires = now() + SESSION_DAYS * 864e5;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)"
  ).bind(uid(), userId, await sha256b64(token), now(), expires).run();
  return { token, maxAge: SESSION_DAYS * 86400 };
}
__name(startSession, "startSession");
async function tooManyFailures(env, key2, limit) {
  const since = now() - FAIL_WINDOW_MS;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?").bind(key2, since).first();
  return (row && row.n) >= (limit || MAX_FAILED);
}
__name(tooManyFailures, "tooManyFailures");
function exceedsDepth(root, max) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > max) return true;
    if (value && typeof value === "object") {
      for (const k in value) stack.push([value[k], depth + 1]);
    }
  }
  return false;
}
__name(exceedsDepth, "exceedsDepth");
async function noteFailure(env, key2) {
  await env.DB.prepare("INSERT INTO login_attempts (id, key, at) VALUES (?,?,?)").bind(uid(), key2, now()).run();
  await env.DB.prepare("DELETE FROM login_attempts WHERE at < ?").bind(now() - FAIL_WINDOW_MS).run();
}
__name(noteFailure, "noteFailure");
async function clearFailures(env, key2) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key2).run();
}
__name(clearFailures, "clearFailures");
async function ensureOrg(env, user) {
  const orgId = "org_" + user.id;
  const row = await env.DB.prepare("SELECT id FROM orgs WHERE id = ?").bind(orgId).first();
  if (!row) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO orgs (id,name,base_currency,weight_unit,volume_unit,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(orgId, user.email, "USD", "kg", "cbm", t, t),
      env.DB.prepare("INSERT OR IGNORE INTO org_members (org_id,user_id,role,created_at) VALUES (?,?,?,?)").bind(orgId, user.id, "owner", t)
    ]);
  }
  return orgId;
}
__name(ensureOrg, "ensureOrg");
var REPROJECT_DELETES = [
  "DELETE FROM landed_costs WHERE shipment_id IN (SELECT id FROM shipments WHERE plan_id = ?)",
  "DELETE FROM cost_variances WHERE shipment_id IN (SELECT id FROM shipments WHERE plan_id = ?)",
  "DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE shipment_id IN (SELECT id FROM shipments WHERE plan_id = ?))",
  "DELETE FROM invoices WHERE shipment_id IN (SELECT id FROM shipments WHERE plan_id = ?)",
  "DELETE FROM freight_quotes WHERE shipment_id IN (SELECT id FROM shipments WHERE plan_id = ?)",
  "DELETE FROM shipment_refs WHERE shipment_id IN (SELECT id FROM shipments WHERE plan_id = ?)",
  "DELETE FROM shipment_carton_assignments WHERE shipment_id IN (SELECT id FROM shipments WHERE plan_id = ?)",
  "DELETE FROM shipment_allocations WHERE shipment_id IN (SELECT id FROM shipments WHERE plan_id = ?)",
  "DELETE FROM cartons WHERE plan_product_id IN (SELECT id FROM plan_products WHERE plan_id = ?)",
  "DELETE FROM shipments WHERE plan_id = ?",
  "DELETE FROM plan_products WHERE plan_id = ?",
  "DELETE FROM plan_versions WHERE plan_id = ?"
];
async function reprojectPlan(env, user, planId, planData) {
  const orgId = await ensureOrg(env, user);
  const { rows } = projectPlan(planData, { orgId, planId, userId: user.id, at: now(), sourceApp: "shipsplit" });
  const ops = REPROJECT_DELETES.map((sql) => env.DB.prepare(sql).bind(planId));
  for (const table of PROJECTION_TABLES) {
    for (const row of rows[table]) {
      const cols = Object.keys(row);
      const verb = table === "skus" || table === "locations" ? "INSERT OR IGNORE" : "INSERT OR REPLACE";
      ops.push(env.DB.prepare(
        verb + " INTO " + table + " (" + cols.join(",") + ") VALUES (" + cols.map(() => "?").join(",") + ")"
      ).bind(...cols.map((c) => row[c])));
    }
  }
  await env.DB.batch(ops);
  return ops.length;
}
__name(reprojectPlan, "reprojectPlan");
async function reprojectSafely(env, user, planId, planData) {
  try {
    await reprojectPlan(env, user, planId, planData);
  } catch (err) {
    console.error("projection failed for plan " + planId + ": " + (err && err.stack || err));
  }
}
__name(reprojectSafely, "reprojectSafely");
function safeName(name) {
  return String(name || "file").replace(/[\\/\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 200) || "file";
}
__name(safeName, "safeName");
async function ownedPlan(env, user, planName) {
  return await env.DB.prepare(
    "SELECT id FROM plans WHERE user_id = ? AND name = ? AND deleted_at IS NULL"
  ).bind(user.id, planName).first();
}
__name(ownedPlan, "ownedPlan");
async function uploadFile(req, env, user, planName, shipmentClientId, origin) {
  if (!env.FILES) return json({ error: "File storage is not configured." }, 503, origin);
  const plan = await ownedPlan(env, user, planName);
  if (!plan) return json({ error: "Plan not found." }, 404, origin);
  const url = new URL(req.url);
  const fileName = safeName(url.searchParams.get("name"));
  const kindRaw = url.searchParams.get("kind") || "other";
  const kind = FILE_KINDS.includes(kindRaw) ? kindRaw : "other";
  const notes = (url.searchParams.get("notes") || "").slice(0, 500);
  const body = await req.arrayBuffer();
  if (!body.byteLength) return json({ error: "Empty file." }, 400, origin);
  if (body.byteLength > MAX_FILE_BYTES) return json({ error: "File is larger than 25 MB." }, 413, origin);
  const declared = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const contentType = SAFE_CONTENT_TYPES.includes(declared) ? declared : "application/octet-stream";
  const digest = b64(await crypto.subtle.digest("SHA-256", body));
  const orgId = await ensureOrg(env, user);
  const id = uid();
  const r2Key = orgId + "/" + plan.id + "/" + (shipmentClientId || "plan") + "/" + id + "-" + fileName;
  await env.FILES.put(r2Key, body, { httpMetadata: { contentType } });
  const t = now();
  await env.DB.prepare(
    "INSERT INTO attachments (id,org_id,entity_type,entity_id,plan_id,kind,file_name,content_type,size_bytes,sha256,r2_key,uploaded_by,notes,source_app,source_ref,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)"
  ).bind(
    id,
    orgId,
    "shipments",
    shipmentClientId || "",
    plan.id,
    kind,
    fileName,
    contentType,
    body.byteLength,
    digest,
    r2Key,
    user.id,
    notes,
    "shipsplit",
    shipmentClientId || "",
    t,
    t
  ).run();
  return json({ id, fileName, kind, contentType, size: body.byteLength, shipmentId: shipmentClientId }, 200, origin);
}
__name(uploadFile, "uploadFile");
async function listFiles(env, user, planName, origin) {
  const plan = await ownedPlan(env, user, planName);
  if (!plan) return json({ error: "Plan not found." }, 404, origin);
  const { results } = await env.DB.prepare(
    "SELECT id, entity_id AS shipmentId, kind, file_name AS fileName, content_type AS contentType, size_bytes AS size, notes, created_at AS uploadedAt FROM attachments WHERE plan_id = ? AND deleted_at IS NULL ORDER BY created_at DESC"
  ).bind(plan.id).all();
  return json({ files: results || [] }, 200, origin);
}
__name(listFiles, "listFiles");
async function downloadFile(env, user, fileId, origin) {
  if (!env.FILES) return json({ error: "File storage is not configured." }, 503, origin);
  const row = await env.DB.prepare(
    "SELECT a.* FROM attachments a JOIN plans p ON p.id = a.plan_id WHERE a.id = ? AND p.user_id = ? AND a.deleted_at IS NULL"
  ).bind(fileId, user.id).first();
  if (!row) return json({ error: "File not found." }, 404, origin);
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return json({ error: "File is missing from storage." }, 404, origin);
  return new Response(obj.body, {
    status: 200,
    headers: Object.assign({
      "Content-Type": row.content_type || "application/octet-stream",
      // always a download: never let an uploaded document render in the API's own origin
      "Content-Disposition": 'attachment; filename="' + safeName(row.file_name) + '"',
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store"
    }, corsHeaders(origin))
  });
}
__name(downloadFile, "downloadFile");
async function deleteFile(env, user, fileId, origin) {
  const row = await env.DB.prepare(
    "SELECT a.id, a.r2_key FROM attachments a JOIN plans p ON p.id = a.plan_id WHERE a.id = ? AND p.user_id = ? AND a.deleted_at IS NULL"
  ).bind(fileId, user.id).first();
  if (!row) return json({ error: "File not found." }, 404, origin);
  await env.DB.prepare("UPDATE attachments SET deleted_at = ? WHERE id = ?").bind(now(), row.id).run();
  if (env.FILES) {
    try {
      await env.FILES.delete(row.r2_key);
    } catch (e) {
    }
  }
  return json({ id: fileId, deleted: true }, 200, origin);
}
__name(deleteFile, "deleteFile");
async function signup(req, env, origin, ip) {
  const keySignup = "signup:" + ip;
  if (await tooManyFailures(env, keySignup, MAX_SIGNUPS_PER_IP)) {
    return json({ error: "Too many accounts created from this device. Try again later." }, 429, origin);
  }
  const body = await req.json().catch(() => ({}));
  const email = normEmail(body.email);
  const password = String(body.password || "");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400, origin);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400, origin);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return json({ error: "That email already has an account. Sign in instead." }, 409, origin);
  const salt = randomB64(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  const userId = uid();
  await env.DB.prepare(
    "INSERT INTO users (id, email, pw_salt, pw_hash, iterations, created_at) VALUES (?,?,?,?,?,?)"
  ).bind(userId, email, salt, hash, PBKDF2_ITERATIONS, now()).run();
  const codes = [];
  const stmt = env.DB.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, used_at) VALUES (?,?,?,NULL)");
  const batch = [];
  for (let i = 0; i < 8; i++) {
    const code = recoveryCode();
    codes.push(code);
    batch.push(stmt.bind(uid(), userId, await sha256b64(code)));
  }
  await env.DB.batch(batch);
  await noteFailure(env, keySignup);
  const { token, maxAge } = await startSession(env, userId);
  return json({ email, recoveryCodes: codes }, 200, origin, { "Set-Cookie": sessionCookie(token, maxAge) });
}
__name(signup, "signup");
async function regenerateCodes(req, env, user, origin) {
  const body = await req.json().catch(() => ({}));
  const password = String(body.password || "");
  const row = await env.DB.prepare("SELECT pw_salt, pw_hash, iterations FROM users WHERE id = ?").bind(user.id).first();
  if (!row) return json({ error: "Not signed in." }, 401, origin);
  const attempt = await pbkdf2(password, row.pw_salt, row.iterations);
  if (!safeEqual(attempt, row.pw_hash)) return json({ error: "Wrong password." }, 401, origin);
  const codes = [];
  const ops = [env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(user.id)];
  const stmt = env.DB.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, used_at) VALUES (?,?,?,NULL)");
  for (let i = 0; i < 8; i++) {
    const code = recoveryCode();
    codes.push(code);
    ops.push(stmt.bind(uid(), user.id, await sha256b64(code)));
  }
  await env.DB.batch(ops);
  return json({ recoveryCodes: codes }, 200, origin);
}
__name(regenerateCodes, "regenerateCodes");
async function login(req, env, origin, ip) {
  const body = await req.json().catch(() => ({}));
  const email = normEmail(body.email);
  const password = String(body.password || "");
  const keyIp = "ip:" + ip, keyEmail = "email:" + email;
  if (await tooManyFailures(env, keyIp)) {
    return json({ error: "Too many failed attempts from this device. Wait 15 minutes." }, 429, origin);
  }
  const user = await env.DB.prepare("SELECT id, pw_salt, pw_hash, iterations FROM users WHERE email = ?").bind(email).first();
  const salt = user ? user.pw_salt : randomB64(16);
  const iters = user ? user.iterations : PBKDF2_ITERATIONS;
  const attempt = await pbkdf2(password, salt, iters);
  if (!user || !safeEqual(attempt, user.pw_hash)) {
    await noteFailure(env, keyIp);
    await noteFailure(env, keyEmail);
    if (await tooManyFailures(env, keyEmail, MAX_FAILED_EMAIL)) {
      return json({ error: "Too many failed attempts for this account. Wait 15 minutes." }, 429, origin);
    }
    return json({ error: "Wrong email or password." }, 401, origin);
  }
  await clearFailures(env, keyIp);
  await clearFailures(env, keyEmail);
  const { token, maxAge } = await startSession(env, user.id);
  return json({ email }, 200, origin, { "Set-Cookie": sessionCookie(token, maxAge) });
}
__name(login, "login");
async function recover(req, env, origin, ip) {
  const body = await req.json().catch(() => ({}));
  const email = normEmail(body.email);
  const code = String(body.code || "").trim().toUpperCase();
  const newPassword = String(body.newPassword || "");
  const keyIp = "ip:" + ip, keyRecEmail = "recover:" + email;
  if (await tooManyFailures(env, keyIp) || await tooManyFailures(env, keyRecEmail, MAX_FAILED_EMAIL)) {
    return json({ error: "Too many attempts. Wait 15 minutes." }, 429, origin);
  }
  if (newPassword.length < 8) return json({ error: "New password must be at least 8 characters." }, 400, origin);
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (!user) {
    await env.DB.prepare("SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").bind("no-such-user", await sha256b64(code)).first();
    await noteFailure(env, keyIp);
    await noteFailure(env, keyRecEmail);
    return json({ error: "Wrong email or recovery code." }, 401, origin);
  }
  const codeHash = await sha256b64(code);
  const row = await env.DB.prepare(
    "SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL"
  ).bind(user.id, codeHash).first();
  if (!row) {
    await noteFailure(env, keyIp);
    await noteFailure(env, keyRecEmail);
    return json({ error: "Wrong email or recovery code." }, 401, origin);
  }
  const salt = randomB64(16);
  const hash = await pbkdf2(newPassword, salt, PBKDF2_ITERATIONS);
  await env.DB.batch([
    env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ?").bind(now(), row.id),
    env.DB.prepare("UPDATE users SET pw_salt = ?, pw_hash = ?, iterations = ? WHERE id = ?").bind(salt, hash, PBKDF2_ITERATIONS, user.id),
    // a password reset invalidates every existing session
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id)
  ]);
  await clearFailures(env, keyIp);
  await clearFailures(env, keyRecEmail);
  const { token, maxAge } = await startSession(env, user.id);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(user.id).first();
  return json({ email, codesRemaining: left ? left.n : 0 }, 200, origin, { "Set-Cookie": sessionCookie(token, maxAge) });
}
__name(recover, "recover");
async function listPlans(env, user, origin) {
  const { results } = await env.DB.prepare(
    "SELECT name, updated_at FROM plans WHERE user_id = ? AND deleted_at IS NULL ORDER BY name"
  ).bind(user.id).all();
  return json({ plans: (results || []).map((r) => ({ name: r.name, updatedAt: r.updated_at })) }, 200, origin);
}
__name(listPlans, "listPlans");
async function getPlan(env, user, name, origin) {
  const row = await env.DB.prepare(
    "SELECT name, data, updated_at FROM plans WHERE user_id = ? AND name = ? AND deleted_at IS NULL"
  ).bind(user.id, name).first();
  if (!row) return json({ error: "No such plan." }, 404, origin);
  let data;
  try {
    data = JSON.parse(row.data);
  } catch (e) {
    data = null;
  }
  return json({ name: row.name, data, updatedAt: row.updated_at }, 200, origin);
}
__name(getPlan, "getPlan");
async function putPlan(req, env, user, name, origin) {
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body.data !== "object" || body.data === null) return json({ error: "Missing plan data." }, 400, origin);
  if (exceedsDepth(body.data, MAX_PLAN_DEPTH)) return json({ error: "Plan structure is nested too deeply." }, 400, origin);
  const serialized = JSON.stringify(body.data);
  if (serialized.length > MAX_PLAN_BYTES) return json({ error: "Plan is too large." }, 413, origin);
  const incoming = Number(body.updatedAt) || now();
  const existing = await env.DB.prepare("SELECT id, updated_at, deleted_at FROM plans WHERE user_id = ? AND name = ?").bind(user.id, name).first();
  if (!existing) {
    await env.DB.prepare("INSERT INTO plans (id, user_id, name, data, updated_at, deleted_at) VALUES (?,?,?,?,?,NULL)").bind(uid(), user.id, name, serialized, incoming).run();
    const fresh = await env.DB.prepare("SELECT id FROM plans WHERE user_id = ? AND name = ?").bind(user.id, name).first();
    if (fresh) await reprojectSafely(env, user, fresh.id, body.data);
    return json({ name, updatedAt: incoming, written: true }, 200, origin);
  }
  if (existing.updated_at > incoming) {
    return json({ name, updatedAt: existing.updated_at, written: false, reason: existing.deleted_at ? "deleted more recently" : "server copy is newer" }, 200, origin);
  }
  await env.DB.prepare("UPDATE plans SET data = ?, updated_at = ?, deleted_at = NULL WHERE id = ?").bind(serialized, incoming, existing.id).run();
  await reprojectSafely(env, user, existing.id, body.data);
  return json({ name, updatedAt: incoming, written: true }, 200, origin);
}
__name(putPlan, "putPlan");
async function deletePlan(env, user, name, origin) {
  const ts = now();
  await env.DB.prepare("UPDATE plans SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND name = ?").bind(ts, ts, user.id, name).run();
  return json({ name, deleted: true, updatedAt: ts }, 200, origin);
}
__name(deletePlan, "deletePlan");
async function syncPlans(req, env, user, origin) {
  const body = await req.json().catch(() => ({}));
  const incoming = body && typeof body.plans === "object" && body.plans || {};
  const deleted = body && typeof body.deleted === "object" && body.deleted || {};
  const { results } = await env.DB.prepare("SELECT id, name, data, updated_at, deleted_at FROM plans WHERE user_id = ?").bind(user.id).all();
  const server = new Map((results || []).map((r) => [r.name, r]));
  const ops = [];
  const touched = /* @__PURE__ */ new Set();
  for (const name of Object.keys(incoming)) {
    const plan = incoming[name];
    if (!plan || typeof plan !== "object") continue;
    if (exceedsDepth(plan, MAX_PLAN_DEPTH)) continue;
    const serialized = JSON.stringify(plan);
    if (serialized.length > MAX_PLAN_BYTES) continue;
    const ts = Number(plan.updatedAt) || 0;
    const row = server.get(name);
    if (!row) {
      ops.push(env.DB.prepare("INSERT INTO plans (id,user_id,name,data,updated_at,deleted_at) VALUES (?,?,?,?,?,NULL)").bind(uid(), user.id, name, serialized, ts));
      server.set(name, { name, data: serialized, updated_at: ts, deleted_at: null });
      touched.add(name);
    } else if (ts > row.updated_at) {
      ops.push(env.DB.prepare("UPDATE plans SET data=?, updated_at=?, deleted_at=NULL WHERE id=?").bind(serialized, ts, row.id));
      row.data = serialized;
      row.updated_at = ts;
      row.deleted_at = null;
      touched.add(name);
    }
  }
  for (const name of Object.keys(deleted)) {
    const ts = Number(deleted[name]) || 0;
    const row = server.get(name);
    if (row && ts > row.updated_at) {
      ops.push(env.DB.prepare("UPDATE plans SET deleted_at=?, updated_at=? WHERE id=?").bind(ts, ts, row.id));
      row.deleted_at = ts;
      row.updated_at = ts;
    }
  }
  if (ops.length) await env.DB.batch(ops);
  for (const name of touched) {
    const row = server.get(name);
    if (!row || row.deleted_at) continue;
    const live = await env.DB.prepare("SELECT id FROM plans WHERE user_id = ? AND name = ?").bind(user.id, name).first();
    if (!live) continue;
    try {
      await reprojectSafely(env, user, live.id, JSON.parse(row.data));
    } catch (e) {
    }
  }
  const out = {}, tomb = {};
  for (const [name, row] of server) {
    if (row.deleted_at) {
      tomb[name] = row.deleted_at;
      continue;
    }
    try {
      out[name] = JSON.parse(row.data);
    } catch (e) {
    }
  }
  return json({ plans: out, deleted: tomb }, 200, origin);
}
__name(syncPlans, "syncPlans");
var src_default = {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (!originAllowed(origin, req)) {
        return json({ error: "Bad origin." }, 403, origin);
      }
    }
    try {
      if (path === "/health") return json({ ok: true, service: "shipsplit-api" }, 200, origin);
      if (path === "/auth/signup" && req.method === "POST") return await signup(req, env, origin, ip);
      if (path === "/auth/login" && req.method === "POST") return await login(req, env, origin, ip);
      if (path === "/auth/recover" && req.method === "POST") return await recover(req, env, origin, ip);
      if (path === "/auth/logout" && req.method === "POST") {
        const user2 = await currentUser(req, env);
        if (user2) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(user2.sessionId).run();
        return json({ ok: true }, 200, origin, { "Set-Cookie": sessionCookie("", 0) });
      }
      const user = await currentUser(req, env);
      if (path === "/auth/me") {
        return user ? json({ email: user.email }, 200, origin) : json({ error: "Not signed in." }, 401, origin);
      }
      if (!user) return json({ error: "Not signed in." }, 401, origin);
      if (path === "/auth/recovery-codes" && req.method === "POST") return await regenerateCodes(req, env, user, origin);
      if (path === "/files" && req.method === "GET") {
        const pn = new URL(req.url).searchParams.get("plan") || "";
        return await listFiles(env, user, pn, origin);
      }
      {
        const up = path.match(/^\/plans\/([^/]+)\/files\/([^/]+)$/);
        if (up && req.method === "POST") {
          return await uploadFile(req, env, user, decodeURIComponent(up[1]), decodeURIComponent(up[2]), origin);
        }
        const fm = path.match(/^\/files\/([^/]+)$/);
        if (fm && req.method === "GET") return await downloadFile(env, user, decodeURIComponent(fm[1]), origin);
        if (fm && req.method === "DELETE") return await deleteFile(env, user, decodeURIComponent(fm[1]), origin);
      }
      if (path === "/plans" && req.method === "GET") return await listPlans(env, user, origin);
      if (path === "/plans/sync" && req.method === "POST") return await syncPlans(req, env, user, origin);
      const m = path.match(/^\/plans\/(.+)$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (req.method === "GET") return await getPlan(env, user, name, origin);
        if (req.method === "PUT") return await putPlan(req, env, user, name, origin);
        if (req.method === "DELETE") return await deletePlan(env, user, name, origin);
      }
      return json({ error: "Not found." }, 404, origin);
    } catch (err) {
      console.error("shipsplit-api", err && err.stack || String(err));
      return json({ error: "Server error." }, 500, origin);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-vOx1A9/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-vOx1A9/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
