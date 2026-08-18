/* Worker-origin Sign In: apiBase() returns "" for relative URLs, and that empty
   string must not be treated as "no API" — that made the Sign In button throw
   with no UI on the Cloudflare-hosted app. No browser required. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.resolve(__dirname, "../app.js"), "utf8");
const res = [], ck = (n, c) => res.push((c ? "PASS" : "FAIL") + "  " + n);

function sliceFn(name) {
  const start = src.search(new RegExp("(?:async )?function " + name + "\\("));
  if (start < 0) throw new Error("missing " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error("unbalanced " + name);
}

const API = "https://shipsplit.joel-036.workers.dev";
const fetches = [];
const sandbox = {
  API_KEY: "shipsplit-api-base",
  API_DEFAULT: API,
  location: { origin: API, hostname: "shipsplit.joel-036.workers.dev" },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  fetch: async (url, opts) => { fetches.push({ url, opts }); return { ok: true, url, status: 200 }; },
};
vm.createContext(sandbox);
vm.runInContext([sliceFn("apiBase"), sliceFn("cloudOn"), sliceFn("apiFetch")].join("\n"), sandbox);

vm.runInContext([sliceFn("hostKind"), sliceFn("isCloudflareHost"), sliceFn("isGitHubHost")].join("\n"), sandbox);
ck("Worker origin is classified as the Cloudflare host",
  vm.runInContext("isCloudflareHost()", sandbox) === true);
ck("on the Worker origin, apiBase is a relative (empty) URL",
  vm.runInContext("apiBase()", sandbox) === "");
ck("on the Worker origin, the API is still considered configured",
  vm.runInContext("cloudOn()", sandbox) === true);

(async () => {
  fetches.length = 0;
  let threw = null;
  try { await vm.runInContext('apiFetch("/auth/login", {method:"POST"})', sandbox); }
  catch (e) { threw = e && e.message; }
  ck("Sign In fetch on the Worker origin does not throw no-api", threw !== "no-api");
  ck("Sign In fetch on the Worker origin uses a relative URL",
    threw == null && fetches[0] && fetches[0].url === "/auth/login");
  ck("session cookie is included on the Worker-origin fetch",
    threw == null && fetches[0] && fetches[0].opts && fetches[0].opts.credentials === "include");

  sandbox.location.origin = "https://joenayer.github.io";
  sandbox.location.hostname = "joenayer.github.io";
  ck("github.io is classified as the GitHub host",
    vm.runInContext("isGitHubHost()", sandbox) === true);
  ck("GitHub Pages still has a Worker URL if something asks (not used for login)",
    vm.runInContext("apiBase()", sandbox) === API);
  ck("GitHub Pages still considers the API configured",
    vm.runInContext("cloudOn()", sandbox) === true);

  fetches.length = 0;
  await vm.runInContext('apiFetch("/auth/login", {method:"POST"})', sandbox);
  ck("GitHub Pages fetch goes to the absolute Worker URL",
    fetches[0] && fetches[0].url === API + "/auth/login");

  const fetchSrc = sliceFn("apiFetch").replace(/\/\/[^\n]*/g, "");
  ck("apiFetch no longer uses the falsy-empty-string guard",
    !/if\s*\(\s*!base\s*\)/.test(fetchSrc));

  console.log(res.join("\n"));
  const f = res.filter(x => x.startsWith("FAIL")).length;
  console.log("\n" + (f ? f + " FAILED" : "ALL " + res.length + " CHECKS PASSED"));
  process.exit(f ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
