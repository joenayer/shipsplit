# ShipSplit → real backend (Cloudflare Workers + D1)

## Why

Today ShipSplit is a static page with no server. That forces three problems that cannot be fixed
client-side:

1. **No account recovery.** The GitHub token is encrypted with a password that exists only in the
   user's head. Forget it and, unless another device is still signed in, you are locked out. (This
   happened.)
2. **The token lives in the browser.** `localStorage.shipsplit_gh` holds a GitHub PAT in plaintext,
   and an encrypted copy sits in a *public* repo. It works, but it is a credential with write access
   to two repos sitting in a place we would rather it not be.
3. **Plans are a JSON file in git.** `plans.json` is rewritten wholesale on every save. Merge is a
   hand-rolled last-write-wins with a tombstone map. It works today because there is one user; it has
   no row-level history, no audit, and no real concurrency story.

## Shape

Keep the front end exactly as it is — static, vanilla, on GitHub Pages. Add a small API:

```
browser (GitHub Pages)  ──HTTPS──>  Worker: shipsplit-api  ──>  D1: shipsplit
   index.html / app.js                 auth + plans API           users, sessions, plans
```

- **Cloudflare Workers + D1.** The account already runs four Workers (`paperlove-qbo-bridge`,
  `paperlove-ads-bridge`, `paperlove-veeqo-bridge`, `veeqo-mcp`), so this is the same operational
  surface, not a new vendor. Free tier covers this workload many times over.
- **No GitHub token anywhere.** The Worker owns the data. GitHub sync is retired *after* cutover.

## Auth

Email + password, with **recovery codes instead of a password-reset email** — deliberately, so the
system has no dependency on an email provider and no "reset link" attack surface.

- Password hashing: **PBKDF2-SHA256, 310k iterations**, 16-byte random salt, via WebCrypto (the same
  primitive the current client already uses, and available natively in Workers). Current OWASP
  guidance is ~600k; 310k is the deliberate choice here because each sign-in spends that as Worker
  CPU, and the free plan's per-request CPU budget is tight. `iterations` is stored per user, so
  raising it later is a one-constant change that upgrades accounts as they next set a password —
  no migration.
- On sign-up the user is shown **8 one-time recovery codes** (80 bits each, unambiguous alphabet).
  Each is stored only as a hash. Any one code logs you in once and forces setting a new password.
  This is the fix for the exact failure that motivated the migration. `POST /auth/recovery-codes`
  (authenticated, re-asks for the password) issues a fresh batch, so exhausting all eight is not a
  dead end.
- Sessions: opaque 32-byte random token (base64url), SHA-256 hashed at rest, delivered as a
  `HttpOnly; Secure; SameSite=None` cookie (None is required — the page is on `github.io`, the API on
  `workers.dev`), **fixed 30-day expiry** (not sliding — activity does not extend it, so a stolen
  session cannot be kept alive indefinitely), revocable server-side and killed en masse on
  password reset.
- **CSRF:** `SameSite=None` means the browser attaches the cookie cross-site, and CORS does not stop a
  "simple" request (`Content-Type: text/plain` skips the preflight and still reaches the handler).
  Every mutating request therefore requires a recognised `Origin`; this was verified exploitable
  against `/plans/sync` before the check existed.
- Rate limiting: per-IP back-off (10 failures / 15 min) on sign-in, recovery and sign-up. The
  per-account counter is a distributed-guessing backstop that is only ever consulted **after** a
  password has already proved wrong — so someone who knows the email cannot lock the owner out by
  burning failed attempts, which an earlier per-account pre-check did allow.

## Data model

```sql
users     (id, email UNIQUE, pw_salt, pw_hash, created_at)
recovery  (id, user_id, code_hash, used_at)
sessions  (id, user_id, token_hash, created_at, expires_at)
plans     (id, user_id, name, data JSON, updated_at, deleted_at)   UNIQUE(user_id, name)
```

`plans.data` stays the *exact* JSON shape the client already uses, so the client's plan objects, the
importer, the exporters and the xlsx code need no changes at all. `deleted_at` replaces the
`__deleted__` tombstone map. `updated_at` keeps the existing newer-wins merge semantics, so the sync
logic the client already has continues to work — it just talks to the API instead of the Contents API.

## API

```
POST /auth/signup    {email, password}          -> {recoveryCodes[]}   (shown once)
POST /auth/login     {email, password}          -> sets session cookie
POST /auth/recover   {email, code, newPassword} -> sets session cookie
POST /auth/logout
GET  /auth/me                                   -> {email} | 401
POST /auth/recovery-codes {password}            -> {recoveryCodes[]}  (fresh batch, invalidates unused)
GET  /plans                                     -> [{name, updatedAt}]        (index, no bodies)
GET  /plans/:name                               -> {name, data, updatedAt}
PUT  /plans/:name    {data, updatedAt}          -> newer-wins upsert
DELETE /plans/:name                             -> soft delete
POST /plans/sync     {plans, deleted}           -> full two-way merge (mirrors today's mergeStores)
```

CORS is locked to `https://joenayer.github.io` with credentials.

## Cutover — staged, never a big bang

Shipments are in transit right now, so nothing switches until it is proven:

1. **Provision** D1 + schema. Zero user impact. ← *done in this change*
2. **Deploy** the Worker. Nothing points at it yet. Zero user impact.
3. **Migrate** the existing plan into D1 (script included). Zero user impact — GitHub keeps working.
4. **Opt in.** The client gets a `backend` mode, off by default. Turn it on, verify the plan loads,
   saves, and syncs across two devices. GitHub sync stays live the whole time as the fallback.
5. **Default on**, GitHub sync demoted to "export only".
6. **Retire** the PAT: delete `sync-config.json`, revoke the token, remove `plans.json`.

Rollback at any step is "flip the setting back".

## What this change contains

- `worker/` — the Worker (auth + plans API), `wrangler.toml`, `schema.sql`
- `worker/migrate.mjs` — loads an exported `plans.json` into D1 via the API
- `worker/test/` — a local test harness that runs the auth + plans flows against `wrangler dev`
- D1 database provisioned and schema applied
- **Not** wired into the client yet — step 4 above is a separate, reviewable change

## Deploying it (one command, needs your Cloudflare login)

```bash
cd worker
npx wrangler login          # once
npx wrangler deploy         # prints the API URL
```

The D1 binding is already in `wrangler.toml`; no secrets to set.
