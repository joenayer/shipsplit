/* ShipSplit API — Cloudflare Worker + D1.
   Owns accounts and plans so the browser never holds a GitHub token, and so a forgotten password is
   recoverable (one-time recovery codes) instead of terminal.

   Every response is JSON. Auth is an opaque session cookie; only its SHA-256 is stored. */
"use strict";

const ALLOWED_ORIGINS = [
  "https://joenayer.github.io",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
];
const PBKDF2_ITERATIONS = 310000;
const SESSION_DAYS = 30;
const MAX_FAILED = 10;              // failed sign-ins from one IP ...
const FAIL_WINDOW_MS = 15 * 60000;  // ... within this window before we start refusing
const MAX_FAILED_EMAIL = 50;        // distributed-guessing backstop; only counts WRONG passwords
const MAX_SIGNUPS_PER_IP = 5;       // account creation is unauthenticated and costs a PBKDF2
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_DEPTH = 32;          // plans nest ~5 deep; anything near this is pathological

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Vary": "Origin",
  };
}
function json(data, status, origin, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      corsHeaders(origin),
      extraHeaders || {}
    ),
  });
}
async function sha256b64(str) {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}
/* length-independent comparison so a hash check can't be timed */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function pbkdf2(password, saltB64, iterations) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return b64(bits);
}
function randomB64(bytes) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes)));
}
/* session tokens go in a cookie, so use base64url with no padding: no '+', '/' or '=' to worry
   about in cookie parsing, logging or URLs */
function randomToken(bytes) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/* recovery codes: human-transcribable, no ambiguous characters */
function recoveryCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += alphabet[raw[i] % alphabet.length];
    if (i % 4 === 3 && i !== 15) out += "-";
  }
  return out; // e.g. K4M9-QR2T-7XZP-BW3N
}
function normEmail(s) { return String(s || "").trim().toLowerCase(); }

function sessionCookie(token, maxAgeSec) {
  const parts = [
    "ss_session=" + token,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None",           // the page lives on github.io, the API on workers.dev
    "Max-Age=" + maxAgeSec,
  ];
  return parts.join("; ");
}
function readCookie(req, name) {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

/* ---------- auth plumbing ---------- */
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
async function startSession(env, userId) {
  const token = randomToken(32);
  const expires = now() + SESSION_DAYS * 86400000;
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)"
  ).bind(uid(), userId, await sha256b64(token), now(), expires).run();
  return { token, maxAge: SESSION_DAYS * 86400 };
}
async function tooManyFailures(env, key, limit) {
  const since = now() - FAIL_WINDOW_MS;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?")
    .bind(key, since).first();
  return (row && row.n) >= (limit || MAX_FAILED);
}
/* Reject bodies that are pathologically NESTED. The byte cap can't help here: JSON.stringify
   recurses per level and blows the stack before we ever get a length to measure. Iterative so the
   check itself cannot overflow on the very input it is guarding against. */
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
async function noteFailure(env, key) {
  await env.DB.prepare("INSERT INTO login_attempts (id, key, at) VALUES (?,?,?)").bind(uid(), key, now()).run();
  await env.DB.prepare("DELETE FROM login_attempts WHERE at < ?").bind(now() - FAIL_WINDOW_MS).run();
}
async function clearFailures(env, key) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

/* ---------- route handlers ---------- */
async function signup(req, env, origin, ip) {
  /* account creation is unauthenticated and each one costs a full PBKDF2 plus 10 rows, so it needs
     the same per-IP ceiling the other public routes have */
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

  // eight single-use recovery codes — the answer to "I forgot my password"
  const codes = [];
  const stmt = env.DB.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, used_at) VALUES (?,?,?,NULL)");
  const batch = [];
  for (let i = 0; i < 8; i++) {
    const code = recoveryCode();
    codes.push(code);
    batch.push(stmt.bind(uid(), userId, await sha256b64(code)));
  }
  await env.DB.batch(batch);

  await noteFailure(env, keySignup); // counts toward the per-IP account-creation ceiling
  const { token, maxAge } = await startSession(env, userId);
  return json({ email, recoveryCodes: codes }, 200, origin, { "Set-Cookie": sessionCookie(token, maxAge) });
}
/* Issue a fresh batch of recovery codes. Without this, burning all eight leaves the account with no
   reset path at all — the very lockout this design exists to prevent. Requires the current password. */
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

async function login(req, env, origin, ip) {
  const body = await req.json().catch(() => ({}));
  const email = normEmail(body.email);
  const password = String(body.password || "");
  const keyIp = "ip:" + ip, keyEmail = "email:" + email;

  /* Throttle on the ATTACKER's side of the request (their IP) before doing any work. We deliberately
     do NOT pre-block on the email key: doing so let anyone who merely knows the account's address
     lock the real owner out from their own IP by burning 10 wrong guesses. A correct password now
     always succeeds; the email counter only ever throttles further WRONG guesses (see below). */
  if (await tooManyFailures(env, keyIp)) {
    return json({ error: "Too many failed attempts from this device. Wait 15 minutes." }, 429, origin);
  }
  const user = await env.DB.prepare("SELECT id, pw_salt, pw_hash, iterations FROM users WHERE email = ?").bind(email).first();
  // always run a derivation so a missing account and a wrong password cost the same
  const salt = user ? user.pw_salt : randomB64(16);
  const iters = user ? user.iterations : PBKDF2_ITERATIONS;
  const attempt = await pbkdf2(password, salt, iters);
  if (!user || !safeEqual(attempt, user.pw_hash)) {
    await noteFailure(env, keyIp); await noteFailure(env, keyEmail);
    // distributed-guessing backstop: only reached when the password was ALREADY wrong, so a
    // legitimate sign-in can never be refused by it
    if (await tooManyFailures(env, keyEmail, MAX_FAILED_EMAIL)) {
      return json({ error: "Too many failed attempts for this account. Wait 15 minutes." }, 429, origin);
    }
    return json({ error: "Wrong email or password." }, 401, origin);
  }
  await clearFailures(env, keyIp); await clearFailures(env, keyEmail);
  const { token, maxAge } = await startSession(env, user.id);
  return json({ email }, 200, origin, { "Set-Cookie": sessionCookie(token, maxAge) });
}

async function recover(req, env, origin, ip) {
  const body = await req.json().catch(() => ({}));
  const email = normEmail(body.email);
  const code = String(body.code || "").trim().toUpperCase();
  const newPassword = String(body.newPassword || "");
  const keyIp = "ip:" + ip, keyRecEmail = "recover:" + email;
  // throttle per IP and per account, mirroring login (an attacker rotating IPs was otherwise unbounded)
  if (await tooManyFailures(env, keyIp) || await tooManyFailures(env, keyRecEmail, MAX_FAILED_EMAIL)) {
    return json({ error: "Too many attempts. Wait 15 minutes." }, 429, origin);
  }
  if (newPassword.length < 8) return json({ error: "New password must be at least 8 characters." }, 400, origin);

  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (!user) {
    // do the same hash + lookup an existing account would, so a missing email isn't detectable by timing
    await env.DB.prepare("SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
      .bind("no-such-user", await sha256b64(code)).first();
    await noteFailure(env, keyIp); await noteFailure(env, keyRecEmail);
    return json({ error: "Wrong email or recovery code." }, 401, origin);
  }

  const codeHash = await sha256b64(code);
  const row = await env.DB.prepare(
    "SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL"
  ).bind(user.id, codeHash).first();
  if (!row) { await noteFailure(env, keyIp); await noteFailure(env, keyRecEmail); return json({ error: "Wrong email or recovery code." }, 401, origin); }

  const salt = randomB64(16);
  const hash = await pbkdf2(newPassword, salt, PBKDF2_ITERATIONS);
  await env.DB.batch([
    env.DB.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ?").bind(now(), row.id),
    env.DB.prepare("UPDATE users SET pw_salt = ?, pw_hash = ?, iterations = ? WHERE id = ?").bind(salt, hash, PBKDF2_ITERATIONS, user.id),
    // a password reset invalidates every existing session
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ]);
  await clearFailures(env, keyIp); await clearFailures(env, keyRecEmail);
  const { token, maxAge } = await startSession(env, user.id);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(user.id).first();
  return json({ email, codesRemaining: left ? left.n : 0 }, 200, origin, { "Set-Cookie": sessionCookie(token, maxAge) });
}

/* ---------- plans ---------- */
async function listPlans(env, user, origin) {
  const { results } = await env.DB.prepare(
    "SELECT name, updated_at FROM plans WHERE user_id = ? AND deleted_at IS NULL ORDER BY name"
  ).bind(user.id).all();
  return json({ plans: (results || []).map(r => ({ name: r.name, updatedAt: r.updated_at })) }, 200, origin);
}
async function getPlan(env, user, name, origin) {
  const row = await env.DB.prepare(
    "SELECT name, data, updated_at FROM plans WHERE user_id = ? AND name = ? AND deleted_at IS NULL"
  ).bind(user.id, name).first();
  if (!row) return json({ error: "No such plan." }, 404, origin);
  let data; try { data = JSON.parse(row.data); } catch (e) { data = null; }
  return json({ name: row.name, data, updatedAt: row.updated_at }, 200, origin);
}
/* newer-wins upsert, matching the client's existing merge rule */
async function putPlan(req, env, user, name, origin) {
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body.data !== "object" || body.data === null) return json({ error: "Missing plan data." }, 400, origin);
  if (exceedsDepth(body.data, MAX_PLAN_DEPTH)) return json({ error: "Plan structure is nested too deeply." }, 400, origin);
  const serialized = JSON.stringify(body.data);
  if (serialized.length > MAX_PLAN_BYTES) return json({ error: "Plan is too large." }, 413, origin);
  const incoming = Number(body.updatedAt) || now();
  const existing = await env.DB.prepare("SELECT id, updated_at, deleted_at FROM plans WHERE user_id = ? AND name = ?").bind(user.id, name).first();
  if (!existing) {
    await env.DB.prepare("INSERT INTO plans (id, user_id, name, data, updated_at, deleted_at) VALUES (?,?,?,?,?,NULL)")
      .bind(uid(), user.id, name, serialized, incoming).run();
    return json({ name, updatedAt: incoming, written: true }, 200, origin);
  }
  /* A deletion is just another timestamped event: an older write must not resurrect it. Previously the
     "&& !existing.deleted_at" carve-out meant ANY write, however stale, revived a deleted plan with
     ancient data — reachable simply by an offline device syncing late. */
  if (existing.updated_at > incoming) {
    return json({ name, updatedAt: existing.updated_at, written: false, reason: existing.deleted_at ? "deleted more recently" : "server copy is newer" }, 200, origin);
  }
  await env.DB.prepare("UPDATE plans SET data = ?, updated_at = ?, deleted_at = NULL WHERE id = ?")
    .bind(serialized, incoming, existing.id).run();
  return json({ name, updatedAt: incoming, written: true }, 200, origin);
}
async function deletePlan(env, user, name, origin) {
  // stamp updated_at too, so newer-wins treats the deletion as the latest event for this plan
  const ts = now();
  await env.DB.prepare("UPDATE plans SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND name = ?").bind(ts, ts, user.id, name).run();
  return json({ name, deleted: true, updatedAt: ts }, 200, origin);
}
/* Full two-way merge, mirroring the client's mergeStores(): newer updatedAt wins, a delete that is
   newer than the surviving copy wins. Returns everything the client should now hold. */
async function syncPlans(req, env, user, origin) {
  const body = await req.json().catch(() => ({}));
  const incoming = (body && typeof body.plans === "object" && body.plans) || {};
  const deleted = (body && typeof body.deleted === "object" && body.deleted) || {};
  const { results } = await env.DB.prepare("SELECT id, name, data, updated_at, deleted_at FROM plans WHERE user_id = ?").bind(user.id).all();
  const server = new Map((results || []).map(r => [r.name, r]));
  const ops = [];

  for (const name of Object.keys(incoming)) {
    const plan = incoming[name];
    if (!plan || typeof plan !== "object") continue;
    if (exceedsDepth(plan, MAX_PLAN_DEPTH)) continue;
    const serialized = JSON.stringify(plan);
    if (serialized.length > MAX_PLAN_BYTES) continue;
    const ts = Number(plan.updatedAt) || 0;
    const row = server.get(name);
    if (!row) {
      ops.push(env.DB.prepare("INSERT INTO plans (id,user_id,name,data,updated_at,deleted_at) VALUES (?,?,?,?,?,NULL)")
        .bind(uid(), user.id, name, serialized, ts));
      server.set(name, { name, data: serialized, updated_at: ts, deleted_at: null });
    } else if (ts > row.updated_at) {
      ops.push(env.DB.prepare("UPDATE plans SET data=?, updated_at=?, deleted_at=NULL WHERE id=?").bind(serialized, ts, row.id));
      row.data = serialized; row.updated_at = ts; row.deleted_at = null;
    }
  }
  for (const name of Object.keys(deleted)) {
    const ts = Number(deleted[name]) || 0;
    const row = server.get(name);
    if (row && ts > row.updated_at) {
      ops.push(env.DB.prepare("UPDATE plans SET deleted_at=?, updated_at=? WHERE id=?").bind(ts, ts, row.id));
      row.deleted_at = ts; row.updated_at = ts;
    }
  }
  if (ops.length) await env.DB.batch(ops);

  const out = {}, tomb = {};
  for (const [name, row] of server) {
    if (row.deleted_at) { tomb[name] = row.deleted_at; continue; }
    try { out[name] = JSON.parse(row.data); } catch (e) { /* skip unreadable row */ }
  }
  return json({ plans: out, deleted: tomb }, 200, origin);
}

/* ---------- router ---------- */
export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    /* CSRF guard. The session cookie is SameSite=None (it has to be — the page is on github.io and
       the API on workers.dev), so the browser will attach it to cross-site requests. CORS alone is
       NOT enough: a "simple" request (e.g. Content-Type: text/plain) skips the preflight entirely and
       still reaches the handler, so an attacker page could fire state-changing calls even though it
       cannot read the reply. Verified exploitable against /plans/sync before this check existed.
       Every mutating request must therefore carry an Origin we recognise. */
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return json({ error: "Bad origin." }, 403, origin);
      }
    }

    try {
      if (path === "/" || path === "/health") return json({ ok: true, service: "shipsplit-api" }, 200, origin);

      if (path === "/auth/signup" && req.method === "POST") return await signup(req, env, origin, ip);
      if (path === "/auth/login" && req.method === "POST") return await login(req, env, origin, ip);
      if (path === "/auth/recover" && req.method === "POST") return await recover(req, env, origin, ip);

      if (path === "/auth/logout" && req.method === "POST") {
        const user = await currentUser(req, env);
        if (user) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(user.sessionId).run();
        return json({ ok: true }, 200, origin, { "Set-Cookie": sessionCookie("", 0) });
      }

      const user = await currentUser(req, env);
      if (path === "/auth/me") {
        return user ? json({ email: user.email }, 200, origin) : json({ error: "Not signed in." }, 401, origin);
      }
      if (!user) return json({ error: "Not signed in." }, 401, origin);

      if (path === "/auth/recovery-codes" && req.method === "POST") return await regenerateCodes(req, env, user, origin);
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
      // never leak internals to the browser; the detail goes to the Worker log
      console.error("shipsplit-api", err && err.stack || String(err));
      return json({ error: "Server error." }, 500, origin);
    }
  },
};
