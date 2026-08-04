# Client tests

Browser tests that drive the real `index.html` in Chromium (Playwright), against the real plan data
where possible. They exist because the app has no build step and no framework — the only honest way
to check a rendering change is to render it.

    npm install -g playwright jsdom     # once
    NODE_PATH="$(npm root -g)" node test/inv.js

| file | covers |
|------|--------|
| `inv.js`  | invoice variance maths, plan rollup, summary columns |
| `inv2.js` | charge list + migration from the old fixed grid, estimated customs/duty, reference types, document panel |
| `prop.js` | product weight/dimension edits propagating to every shipment |
| `rates.js` | billed weight/volume, metric storage under the unit toggle, $/weight and $/volume rates |
| `packing.js` | packing list carries no commercial or internal data, and every carton names its PO |

Worker + database tests live in `worker/test/` and need no browser:

    node worker/test/run.mjs        # API, auth, CSRF, projection
    node worker/test/project.mjs    # plan -> normalised tables, landed cost
