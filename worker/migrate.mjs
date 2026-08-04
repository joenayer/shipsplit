#!/usr/bin/env node
/* Load existing ShipSplit plans into the new backend.
 *
 * Accepts either shape:
 *   - the cloud file:   plans.json        ({ "<name>": {...}, "__deleted__": {...} })
 *   - an app backup:    shipsplit-backup-*.json  ({ current: {...}, saved: { "<name>": {...} } })
 *
 * Usage:
 *   SHIPSPLIT_EMAIL=you@example.com SHIPSPLIT_PASSWORD='…' \
 *     node worker/migrate.mjs https://shipsplit-api.<subdomain>.workers.dev ./plans.json [--dry-run]
 *
 * The password is read from the environment, never from argv, so it stays out of your shell history.
 * Migration is a /plans/sync call, so it is idempotent and newer-wins: re-running it is safe and will
 * never overwrite a newer copy that is already on the server.
 */
import { readFileSync } from "node:fs";

const [apiUrl, file] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
const email = process.env.SHIPSPLIT_EMAIL;
const password = process.env.SHIPSPLIT_PASSWORD;

function die(msg) { console.error("error: " + msg); process.exit(1); }
if (!apiUrl || !file) die("usage: node worker/migrate.mjs <api-url> <plans.json> [--dry-run]");
if (!dryRun && (!email || !password)) die("set SHIPSPLIT_EMAIL and SHIPSPLIT_PASSWORD in the environment");

let raw;
try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { die("could not read " + file + ": " + e.message); }

/* normalise both accepted shapes into { plans, deleted } */
const plans = {}, deleted = {};
const source = raw && typeof raw.saved === "object" && raw.saved ? raw.saved : raw;
for (const key of Object.keys(source || {})) {
  if (key === "__deleted__") { Object.assign(deleted, source[key] || {}); continue; }
  const plan = source[key];
  if (plan && typeof plan === "object") plans[key] = plan;
}
if (raw && raw.current && raw.current.planName && !plans[raw.current.planName]) {
  plans[raw.current.planName] = raw.current;   // an unsaved "current" plan in a backup file
}

const names = Object.keys(plans);
console.log("Found " + names.length + " plan(s) in " + file + ":");
for (const n of names) {
  const p = plans[n];
  const cases = (p.products || []).reduce((s, x) => s + ((x.cartons || []).length), 0);
  console.log("  • " + n + "  —  " + (p.products || []).length + " products / " + cases +
    " cases / " + (p.buckets || []).length + " shipments" +
    (p.updatedAt ? "  (updated " + new Date(Number(p.updatedAt)).toISOString().slice(0, 16).replace("T", " ") + ")" : ""));
}
const tombs = Object.keys(deleted);
if (tombs.length) console.log("Plus " + tombs.length + " deletion marker(s): " + tombs.join(", "));
if (!names.length && !tombs.length) die("nothing to migrate");
if (dryRun) { console.log("\n--dry-run: nothing sent."); process.exit(0); }

const base = apiUrl.replace(/\/+$/, "");
async function call(path, body, cookie) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", Origin: "https://joenayer.github.io" },
      cookie ? { Cookie: cookie } : {}),
    body: JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json, setCookie: res.headers.get("Set-Cookie") };
}

console.log("\nSigning in to " + base + " …");
const login = await call("/auth/login", { email, password });
if (login.status !== 200) die("sign-in failed (" + login.status + "): " + ((login.body && login.body.error) || "unknown"));
const cookie = (login.setCookie || "").split(";")[0];
if (!cookie) die("no session cookie returned");
console.log("Signed in as " + login.body.email);

console.log("Uploading …");
const sync = await call("/plans/sync", { plans, deleted }, cookie);
if (sync.status !== 200) die("sync failed (" + sync.status + "): " + ((sync.body && sync.body.error) || "unknown"));

const got = Object.keys(sync.body.plans || {});
console.log("\nServer now holds " + got.length + " plan(s):");
for (const n of got) console.log("  ✓ " + n);
const missing = names.filter(n => !got.includes(n));
if (missing.length) {
  console.log("\nNot present after sync (a newer deletion on the server wins over these): " + missing.join(", "));
}
console.log("\nDone. Your GitHub sync is untouched — nothing was removed from it.");
