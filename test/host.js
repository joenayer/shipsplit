/* One host, one login. GitHub Pages = GitHub store. Cloudflare Worker = account store + landing gate. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const app = fs.readFileSync(path.resolve(__dirname, "../app.js"), "utf8");
const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
const res = [], ck = (n, c) => res.push((c ? "PASS" : "FAIL") + "  " + n);

function sliceFn(name) {
  const start = app.search(new RegExp("(?:async )?function " + name + "\\("));
  if (start < 0) throw new Error("missing " + name);
  let i = app.indexOf("{", start), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === "{") depth++;
    else if (app[i] === "}") { depth--; if (!depth) return app.slice(start, i + 1); }
  }
  throw new Error("unbalanced " + name);
}

const API = "https://shipsplit.joel-036.workers.dev";
function kindAt(origin, hostname) {
  const sandbox = { API_DEFAULT: API, location: { origin, hostname } };
  vm.createContext(sandbox);
  vm.runInContext([sliceFn("hostKind"), sliceFn("isCloudflareHost"), sliceFn("isGitHubHost")].join("\n"), sandbox);
  return {
    kind: vm.runInContext("hostKind()", sandbox),
    cf: vm.runInContext("isCloudflareHost()", sandbox),
    gh: vm.runInContext("isGitHubHost()", sandbox),
  };
}

const cf = kindAt(API, "shipsplit.joel-036.workers.dev");
const gh = kindAt("https://joenayer.github.io", "joenayer.github.io");
const local = kindAt("http://127.0.0.1:8788", "127.0.0.1");

ck("Worker origin is the Cloudflare host", cf.kind === "cf" && cf.cf && !cf.gh);
ck("github.io is the GitHub host", gh.kind === "gh" && gh.gh && !gh.cf);
ck("localhost is neither production host", local.kind === "local" && !local.cf && !local.gh);

ck("landing gate exists on the page", /id="gateOverlay"/.test(html));
ck("gate offers Sign in", /id="btnGateSignin"/.test(html));
ck("gate offers Guest", /id="btnGateGuest"/.test(html));
ck("gate has no Close / dismiss button", !/gateOverlay[\s\S]*?btnGateClose/.test(html) && !/id="btnGateClose"/.test(html));
ck("account copy no longer mentions a second GitHub login",
  !/This is separate from GitHub sync/.test(html));
ck("the 'app has moved' banner is gone — GitHub Pages is a real host",
  !/function maybeOfferNewAddress/.test(app));

const syncSrc = sliceFn("syncEverywhere");
ck("GitHub Pages save path does not write the Worker database",
  /isGitHubHost\(\)/.test(syncSrc) && /pushToCloud/.test(syncSrc));
ck("Cloudflare save path does not write GitHub",
  /isCloudflareHost\(\)/.test(syncSrc) && /apiSyncPlans/.test(syncSrc));

const chrome = sliceFn("applyHostChrome");
ck("Cloudflare chrome hides the GitHub button", /hide\("btnCloud", true\)/.test(chrome));
ck("GitHub chrome hides the account button", /hide\("btnAccount", true\)/.test(chrome));
ck("Cloudflare lander shows the gate unless guest was already chosen",
  /showGate\(\)/.test(chrome) && /loadGuest\(\)/.test(chrome));

const refresh = sliceFn("refreshAccount");
ck("GitHub Pages does not call the account API",
  /isGitHubHost\(\)/.test(refresh) && /apiUser = null/.test(refresh));

const init = sliceFn("initCloudUI");
ck("Cloudflare host does not start GitHub sync", /isCloudflareHost\(\)/.test(init));

console.log(res.join("\n"));
const f = res.filter(x => x.startsWith("FAIL")).length;
console.log("\n" + (f ? f + " FAILED" : "ALL " + res.length + " CHECKS PASSED"));
process.exit(f ? 1 : 0);
