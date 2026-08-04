# ShipSplit API (Cloudflare Worker)

Accounts, plans and shipment documents for [ShipSplit](https://joenayer.github.io/shipsplit/).

- **Live:** https://shipsplit.joel-036.workers.dev
- **Database:** D1 `shipsplit` — accounts, plans, and the normalised v2 tables
- **File storage:** R2 `shipsplit-files` — invoices, labels, packing lists

## Deploying

This directory is connected to Cloudflare Workers Builds, so a push to `main` deploys it. Root
directory is `worker`, there is no build command, and `npx wrangler deploy` is the deploy command.

If a push does not produce a build, open the Worker in the Cloudflare dashboard, go to
**Deployments**, and retry or create one from the latest commit.

## Platform limits worth knowing

**PBKDF2 is capped at 100,000 iterations.** Workers throws
`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported` — it does not
merely run slowly, so any higher value makes every signup and sign-in return a 500. This is an API
ceiling, not a CPU budget, so a larger plan does not lift it. `users.iterations` is stored per row,
so the constant can be raised later and accounts re-hash as passwords are next set.

Node's WebCrypto accepts any iteration count, so local tests cannot catch this. `test/run.mjs`
asserts the constant directly instead.

## Tests

No browser or network needed — the suites run the real Worker against an in-memory SQLite shim:

    node test/run.mjs        # API, auth, CSRF, tenant isolation, projection
    node test/project.mjs    # plan -> normalised tables, landed cost

## Schema

- `schema.sql` — v1: users, sessions, plans, recovery codes, login attempts
- `schema-v2.sql` — the normalised model: catalog, purchasing, planning, money, landed cost,
  inventory ledger, attachments

`plans.data` stays the client's source of truth; everything in v2 is a projection of it, rebuilt on
every save by `src/project.js`.
