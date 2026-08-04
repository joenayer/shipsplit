/* Stage the app's static files into worker/public so the Worker can serve the page and the API from
   the SAME origin. One origin means the session cookie no longer has to be SameSite=None, which is
   what forced the CSRF guard in the first place.
   Copied rather than moved: the files stay at the repo root, so GitHub Pages keeps working unchanged
   during the switchover and remains a fallback. */
import { mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "public");

const FILES = ["index.html", "app.js", "awd-template.js", "xlsx.full.min.js"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let n = 0;
for (const f of FILES) {
  const src = join(root, f);
  if (!existsSync(src)) { console.error("missing: " + f); process.exit(1); }
  copyFileSync(src, join(out, f));
  n++;
}
console.log("staged " + n + " files into worker/public");
