# Agent instructions

Read [`.ai-os/README.md`](.ai-os/README.md), [`BACKEND-PLAN.md`](BACKEND-PLAN.md), and [`worker/README.md`](worker/README.md) before changing this repository.

- Keep `plans.data` compatible with the client unless an explicit migration changes the contract.
- Preserve staged cutover and rollback. Do not retire the GitHub fallback, revoke credentials, migrate live data, or change the deployment path as a side effect.
- Never commit tokens, cookies, recovery codes, passwords, exported user plans, or live shipment documents.
- Treat plan names, imported JSON, uploaded files, origins, and external identifiers as untrusted input.
- Keep unknown, missing, deleted, and zero distinct. Preserve tenant isolation, CSRF checks, soft deletion, and audit history.
- For Worker changes, run `npm test` and `npm run build` from `worker/`. Do not deploy unless explicitly authorized.

The repository is the source of truth for project behavior. Joel AI OS supplies shared working preferences only.
