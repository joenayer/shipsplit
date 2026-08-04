/* Runs the real Worker module against an in-memory SQLite D1 shim, so the auth and plan logic is
   exercised end to end without deploying. Run: node worker/test/run.mjs   (from the repo root) */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const schemaV2 = readFileSync(new URL("../schema-v2.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec(schema);
db.exec(schemaV2);

/* Minimal D1 shim: prepare().bind().first()/run()/all(), plus batch(). */
function d1(sqlite) {
  const wrap = (sql, params = []) => ({
    bind: (...p) => wrap(sql, p),
    async first() { const r = sqlite.prepare(sql).get(...params); return r === undefined ? null : r; },
    async run() { return { success: true, meta: sqlite.prepare(sql).run(...params) }; },
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    _exec() { return sqlite.prepare(sql).run(...params); },
  });
  return {
    prepare: sql => wrap(sql),
    async batch(stmts) { for (const s of stmts) s._exec(); return stmts.map(() => ({ success: true })); },
  };
}
const env = { DB: d1(db) };

const ORIGIN = "https://joenayer.github.io";
let cookie = "";
async function call(method, path, body, opts = {}) {
  const headers = { Origin: ORIGIN, "CF-Connecting-IP": opts.ip || "203.0.113.5" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie && !opts.noCookie) headers["Cookie"] = cookie;
  const req = new Request("https://api.test" + path, {
    method, headers,
    // rawBody lets a test send a payload too deep for the harness itself to JSON.stringify
    body: opts.rawBody !== undefined ? opts.rawBody : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const res = await worker.fetch(req, env);
  const setCookie = res.headers.get("Set-Cookie");
  if (setCookie && !opts.keepCookie) {
    // a logout is signalled by Max-Age=0, not by an empty-looking value
    cookie = /Max-Age=0(?:;|$)/.test(setCookie) ? "" : setCookie.split(";")[0];
  }
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json, res };
}

const results = [];
const ck = (name, cond) => results.push((cond ? "PASS" : "FAIL") + "  " + name);

/* ---------- health + CORS ---------- */
let r = await call("GET", "/health");
ck("health returns ok", r.status === 200 && r.body.ok === true);
ck("CORS allows the Pages origin with credentials",
  r.res.headers.get("Access-Control-Allow-Origin") === ORIGIN &&
  r.res.headers.get("Access-Control-Allow-Credentials") === "true");
r = await call("OPTIONS", "/plans");
ck("preflight returns 204", r.status === 204);
{
  const bad = await worker.fetch(new Request("https://api.test/health", { headers: { Origin: "https://evil.example" } }), env);
  ck("unknown origin is NOT reflected in CORS", bad.headers.get("Access-Control-Allow-Origin") !== "https://evil.example");
}

/* ---------- CSRF: a cross-site page must not be able to mutate anything ----------
   SameSite=None means the browser WILL attach the session cookie cross-site, and a CORS-"simple"
   request (text/plain) skips the preflight, so the handler is reached. This was exploitable against
   /plans/sync before the Origin check. */
{
  const evil = async (method, path, body, contentType) => {
    const headers = { Origin: "https://evil.example", "CF-Connecting-IP": "203.0.113.9" };
    if (contentType) headers["Content-Type"] = contentType;
    if (cookie) headers["Cookie"] = cookie;
    const res = await worker.fetch(new Request("https://api.test" + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return res.status;
  };
  ck("cross-site POST /plans/sync is refused (text/plain, no preflight)",
    (await evil("POST", "/plans/sync", { plans: {}, deleted: { X: 9e12 } }, "text/plain")) === 403);
  ck("cross-site PUT is refused", (await evil("PUT", "/plans/X", { data: {} }, "text/plain")) === 403);
  ck("cross-site DELETE is refused", (await evil("DELETE", "/plans/X")) === 403);
  ck("cross-site logout is refused", (await evil("POST", "/auth/logout", {}, "text/plain")) === 403);
  ck("cross-site login is refused", (await evil("POST", "/auth/login", { email: "a@b.c", password: "x" }, "text/plain")) === 403);
}

/* ---------- protected routes require auth ---------- */
r = await call("GET", "/plans", undefined, { noCookie: true });
ck("plans require a session (401)", r.status === 401);
r = await call("GET", "/auth/me", undefined, { noCookie: true });
ck("/auth/me is 401 when signed out", r.status === 401);

/* ---------- signup ---------- */
r = await call("POST", "/auth/signup", { email: "Joel@Example.com ", password: "short" });
ck("signup rejects a short password", r.status === 400);
r = await call("POST", "/auth/signup", { email: "not-an-email", password: "correct horse battery" });
ck("signup rejects a bad email", r.status === 400);
r = await call("POST", "/auth/signup", { email: "Joel@Example.com ", password: "correct horse battery" });
ck("signup succeeds", r.status === 200 && r.body.email === "joel@example.com");
const codes = r.body.recoveryCodes || [];
ck("signup returns 8 recovery codes", codes.length === 8);
ck("recovery codes look transcribable", /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(codes[0]));
ck("signup set a session cookie", cookie.startsWith("ss_session="));
{
  const sc = r.res.headers.get("Set-Cookie") || "";
  ck("cookie is HttpOnly + Secure + SameSite=None",
    /HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=None/.test(sc));
}
ck("email is normalised (trim + lowercase)",
  db.prepare("SELECT email FROM users").get().email === "joel@example.com");
ck("password is not stored in plaintext",
  !db.prepare("SELECT pw_hash FROM users").get().pw_hash.includes("correct horse"));
ck("recovery codes are stored hashed, not raw",
  db.prepare("SELECT code_hash FROM recovery_codes LIMIT 1").get().code_hash !== codes[0]);

r = await call("POST", "/auth/signup", { email: "joel@example.com", password: "another password" });
ck("duplicate signup is refused (409)", r.status === 409);

r = await call("GET", "/auth/me");
ck("/auth/me works with the session", r.status === 200 && r.body.email === "joel@example.com");

/* ---------- plans CRUD ---------- */
const plan = { planName: "PO 91+92", po: "091 + 092", products: [], buckets: [], updatedAt: 1000 };
r = await call("PUT", "/plans/" + encodeURIComponent("PO 91+92"), { data: plan, updatedAt: 1000 });
ck("PUT creates a plan", r.status === 200 && r.body.written === true);
r = await call("GET", "/plans");
ck("plan appears in the index", r.status === 200 && r.body.plans.length === 1 && r.body.plans[0].name === "PO 91+92");
r = await call("GET", "/plans/" + encodeURIComponent("PO 91+92"));
ck("GET returns the exact client JSON shape", r.body.data.po === "091 + 092" && r.body.updatedAt === 1000);

r = await call("PUT", "/plans/" + encodeURIComponent("PO 91+92"), { data: { ...plan, po: "OLD" }, updatedAt: 500 });
ck("older write is rejected (newer wins)", r.body.written === false);
r = await call("GET", "/plans/" + encodeURIComponent("PO 91+92"));
ck("server copy unchanged after stale write", r.body.data.po === "091 + 092");
r = await call("PUT", "/plans/" + encodeURIComponent("PO 91+92"), { data: { ...plan, po: "NEW" }, updatedAt: 2000 });
ck("newer write wins", r.body.written === true);

r = await call("DELETE", "/plans/" + encodeURIComponent("PO 91+92"));
ck("DELETE soft-deletes", r.status === 200);
r = await call("GET", "/plans");
ck("deleted plan leaves the index", r.body.plans.length === 0);
ck("row is retained with deleted_at (soft delete)",
  db.prepare("SELECT deleted_at FROM plans WHERE name='PO 91+92'").get().deleted_at !== null);

/* ---------- sync merge ---------- */
r = await call("POST", "/plans/sync", { plans: { Alpha: { planName: "Alpha", updatedAt: 100 } }, deleted: {} });
ck("sync inserts a client-only plan", r.body.plans.Alpha && r.body.plans.Alpha.planName === "Alpha");
r = await call("POST", "/plans/sync", { plans: { Alpha: { planName: "Alpha-new", updatedAt: 200 } }, deleted: {} });
ck("sync takes the newer client copy", r.body.plans.Alpha.planName === "Alpha-new");
r = await call("POST", "/plans/sync", { plans: { Alpha: { planName: "Alpha-stale", updatedAt: 50 } }, deleted: {} });
ck("sync keeps the newer server copy", r.body.plans.Alpha.planName === "Alpha-new");
r = await call("POST", "/plans/sync", { plans: {}, deleted: { Alpha: 300 } });
ck("newer tombstone deletes the plan", !r.body.plans.Alpha && r.body.deleted.Alpha === 300);
r = await call("POST", "/plans/sync", { plans: { Alpha: { planName: "resurrect", updatedAt: 250 } }, deleted: {} });
ck("older plan cannot resurrect a newer deletion", !r.body.plans.Alpha);
r = await call("POST", "/plans/sync", { plans: { Alpha: { planName: "legit-again", updatedAt: 400 } }, deleted: {} });
ck("a genuinely newer plan does come back", r.body.plans.Alpha.planName === "legit-again");

/* ---------- tenant isolation ---------- */
const ownerCookie = cookie;
cookie = "";
r = await call("POST", "/auth/signup", { email: "someone@else.com", password: "another good password" }, { ip: "198.51.100.9" });
ck("second account can sign up", r.status === 200);
r = await call("GET", "/plans");
ck("a different user sees NONE of the first user's plans", r.status === 200 && r.body.plans.length === 0);
r = await call("GET", "/plans/" + encodeURIComponent("Alpha"));
ck("a different user cannot read another's plan by name", r.status === 404);

/* ---------- login + lockout ---------- */
cookie = "";
r = await call("POST", "/auth/login", { email: "joel@example.com", password: "wrong" }, { ip: "192.0.2.1" });
ck("wrong password is rejected", r.status === 401);
ck("error does not reveal whether the account exists", /wrong email or password/i.test(r.body.error));
r = await call("POST", "/auth/login", { email: "joel@example.com", password: "correct horse battery" }, { ip: "192.0.2.1" });
ck("correct password signs in", r.status === 200);
{
  cookie = "";
  let locked = false;
  for (let i = 0; i < 12; i++) {
    const a = await call("POST", "/auth/login", { email: "lock@test.com", password: "nope" }, { ip: "192.0.2.99" });
    if (a.status === 429) { locked = true; break; }
  }
  ck("repeated failures trigger back-off (429)", locked);
}

/* ---------- recovery ---------- */
cookie = "";
r = await call("POST", "/auth/recover", { email: "joel@example.com", code: "AAAA-BBBB-CCCC-DDDD", newPassword: "brand new password" }, { ip: "198.51.100.20" });
ck("a bogus recovery code is refused", r.status === 401);
r = await call("POST", "/auth/recover", { email: "joel@example.com", code: codes[0], newPassword: "brand new password" }, { ip: "198.51.100.21" });
ck("a real recovery code resets the password", r.status === 200);
ck("recovery reports remaining codes", r.body.codesRemaining === 7);
r = await call("POST", "/auth/recover", { email: "joel@example.com", code: codes[0], newPassword: "yet another one" }, { ip: "198.51.100.22" });
ck("a used recovery code cannot be reused", r.status === 401);
cookie = "";
r = await call("POST", "/auth/login", { email: "joel@example.com", password: "brand new password" }, { ip: "192.0.2.7" });
ck("the new password works", r.status === 200);
cookie = "";
r = await call("POST", "/auth/login", { email: "joel@example.com", password: "correct horse battery" }, { ip: "192.0.2.8" });
ck("the old password no longer works", r.status === 401);
{
  const stale = await call("GET", "/auth/me", undefined, { noCookie: true, keepCookie: true });
  cookie = ownerCookie;
  const afterReset = await call("GET", "/auth/me");
  ck("password reset invalidated the old sessions", afterReset.status === 401);
}

/* ---------- logout ---------- */
cookie = "";
r = await call("POST", "/auth/login", { email: "joel@example.com", password: "brand new password" }, { ip: "192.0.2.10" });
const liveCookie = cookie;
r = await call("POST", "/auth/logout");
ck("logout succeeds", r.status === 200);
cookie = liveCookie;
r = await call("GET", "/auth/me");
ck("session is dead after logout", r.status === 401);

/* ---------- fixes from the security review ---------- */

/* an attacker who knows the email must NOT be able to lock the owner out of their own IP */
{
  cookie = "";
  await call("POST", "/auth/signup", { email: "victim@test.com", password: "the real password" }, { ip: "203.0.113.77" });
  cookie = "";
  for (let i = 0; i < 12; i++) {
    await call("POST", "/auth/login", { email: "victim@test.com", password: "guess" + i }, { ip: "198.51.100.66" });
  }
  const attacker = await call("POST", "/auth/login", { email: "victim@test.com", password: "guess-again" }, { ip: "198.51.100.66" });
  ck("attacker's own IP does get throttled", attacker.status === 429);
  cookie = "";
  const victim = await call("POST", "/auth/login", { email: "victim@test.com", password: "the real password" }, { ip: "203.0.113.1" });
  ck("victim with the CORRECT password is NOT locked out", victim.status === 200);
}

/* account creation is unauthenticated and costs a PBKDF2 each time */
{
  cookie = "";
  let blocked = false;
  for (let i = 0; i < 9; i++) {
    const r2 = await call("POST", "/auth/signup", { email: "flood" + i + "@test.com", password: "password12345" }, { ip: "198.51.100.200" });
    if (r2.status === 429) { blocked = true; break; }
  }
  ck("signup is rate limited per IP", blocked);
}

/* a stale write must not resurrect a deleted plan */
{
  cookie = "";
  await call("POST", "/auth/login", { email: "victim@test.com", password: "the real password" }, { ip: "203.0.113.2" });
  await call("PUT", "/plans/Doomed", { data: { contents: "current" }, updatedAt: 1000 });
  await call("DELETE", "/plans/Doomed");
  const stale = await call("PUT", "/plans/Doomed", { data: { contents: "ANCIENT STALE DATA" }, updatedAt: 1 });
  ck("stale PUT cannot resurrect a deleted plan", stale.body.written === false);
  const idx = await call("GET", "/plans");
  ck("resurrected plan does not reappear in the index", !idx.body.plans.some(p => p.name === "Doomed"));
  const fresh = await call("PUT", "/plans/Doomed", { data: { contents: "deliberately restored" }, updatedAt: Date.now() + 60000 });
  ck("a genuinely newer write CAN restore it", fresh.body.written === true);
}

/* deeply nested JSON used to blow the stack inside JSON.stringify and surface as a 500 */
{
  const N = 50000;   // built as a raw string: too deep for JSON.stringify to walk
  const rawBody = '{"updatedAt":' + Date.now() + ',"data":' + '{"n":'.repeat(N) + "{}" + "}".repeat(N) + "}";
  const r2 = await call("PUT", "/plans/Nested", undefined, { rawBody });
  ck("pathologically nested plan is rejected with 400, not a 500", r2.status === 400);
  const alive = await call("GET", "/auth/me");
  ck("API still healthy after the nesting attempt", alive.status === 200);
}

/* burning all 8 recovery codes must not be a dead end */
{
  const bad = await call("POST", "/auth/recovery-codes", { password: "not the password" });
  ck("regenerating codes requires the current password", bad.status === 401);
  const ok = await call("POST", "/auth/recovery-codes", { password: "the real password" });
  ck("recovery codes can be regenerated", ok.status === 200 && (ok.body.recoveryCodes || []).length === 8);
  const fresh = ok.body.recoveryCodes[0];
  cookie = "";
  const used = await call("POST", "/auth/recover", { email: "victim@test.com", code: fresh, newPassword: "a replacement password" }, { ip: "203.0.113.30" });
  ck("a regenerated code actually works", used.status === 200);
}

/* ---------- v2 projection happens on the real write paths ---------- */
{
  cookie = "";
  await call("POST", "/auth/signup", { email: "proj@test.com", password: "a good password" }, { ip: "203.0.113.150" });
  const plan = {
    planName: "Proj", po: "091", shipFrom: "Ningbo", readyDate: "2026-07-01", updatedAt: 5000,
    products: [{ id:"p1", code:"PL-AAA-1", name:"Alpha", deadline:"2026-09-01",
                 cartons:[{n:1,qty:100,dim:"40x30x20",kg:10},{n:2,qty:100,dim:"40x30x20",kg:10}] }],
    buckets: [{ id:"b1", label:"Air 1", mode:"air", destType:"awd", shipTo:"IUSF", quote:"1000",
                transit:"7", allocations:{p1:2}, status:"in-transit", carrier:"Fedex",
                refs:[{type:"tracking",value:"123"}], depDate:"2026-07-10", arrDate:"",
                invoice:{ number:"INV-1", date:"2026-07-20", currency:"USD", amount:"1250",
                          lines:{freight:"1000",storage:"250"}, status:"received", paidDate:"", notes:"" } }],
  };
  await call("PUT", "/plans/Proj", { data: plan, updatedAt: 5000 });

  const q = sql => db.prepare(sql).get();
  ck("PUT projects the plan into v2 tables", q("SELECT COUNT(*) n FROM plan_products").n === 1);
  ck("PUT projects cartons", q("SELECT COUNT(*) n FROM cartons").n === 2);
  ck("PUT projects the shipment", q("SELECT COUNT(*) n FROM shipments").n === 1);
  ck("PUT creates an org for this user on first write",
    db.prepare("SELECT COUNT(*) n FROM orgs WHERE name='proj@test.com'").get().n === 1);
  ck("the org has the user as owner",
    db.prepare("SELECT COUNT(*) n FROM org_members m JOIN users u ON u.id=m.user_id WHERE u.email='proj@test.com' AND m.role='owner'").get().n === 1);
  ck("each account gets its own org (no cross-tenant mixing)",
    db.prepare("SELECT COUNT(DISTINCT org_id) n FROM plan_versions").get().n ===
    db.prepare("SELECT COUNT(DISTINCT user_id) n FROM plans p WHERE EXISTS (SELECT 1 FROM plan_versions v WHERE v.plan_id=p.id)").get().n);
  ck("PUT projects the SKU into the catalog", q("SELECT COUNT(*) n FROM skus WHERE code='PL-AAA-1'").n === 1);
  ck("PUT projects the invoice in cents", q("SELECT total_minor m FROM invoices").m === 125000);
  ck("PUT projects itemised charges", q("SELECT COUNT(*) n FROM invoice_lines").n === 2);
  ck("PUT computes the variance (+$250)", q("SELECT delta_minor d FROM cost_variances").d === 25000);
  ck("PUT computes landed cost per unit", q("SELECT unit_cost_minor c FROM landed_costs WHERE is_estimate=0").c === 625);

  // removing a shipment must clear its projected children, not leave phantom costs
  const plan2 = JSON.parse(JSON.stringify(plan));
  plan2.buckets = [];
  await call("PUT", "/plans/Proj", { data: plan2, updatedAt: 6000 });
  ck("re-projection removes shipments deleted in the client", q("SELECT COUNT(*) n FROM shipments").n === 0);
  ck("re-projection removes their invoices too", q("SELECT COUNT(*) n FROM invoices").n === 0);
  ck("re-projection removes their landed costs too", q("SELECT COUNT(*) n FROM landed_costs").n === 0);
  ck("re-projection keeps the SKU catalog (outlives the plan)", q("SELECT COUNT(*) n FROM skus WHERE code='PL-AAA-1'").n === 1);

  // sync path projects as well
  const plan3 = JSON.parse(JSON.stringify(plan));
  plan3.planName = "ViaSync";
  await call("POST", "/plans/sync", { plans: { ViaSync: Object.assign({}, plan3, {updatedAt: 9000}) }, deleted: {} });
  ck("sync projects too", db.prepare("SELECT COUNT(*) n FROM shipments").get().n === 1);
}

console.log(results.join("\n"));
const failed = results.filter(x => x.startsWith("FAIL")).length;
console.log("\n" + (failed ? failed + " FAILED" : "ALL " + results.length + " CHECKS PASSED"));
process.exit(failed ? 1 : 0);
