
"use strict";
/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2,9);
const fmt = (n,d=1) => (n==null||isNaN(n)) ? "-" : Number(n).toLocaleString("en-US",{maximumFractionDigits:d});
const fmt$ = n => (n==null||isNaN(n)||n==="") ? "-" : "$"+Number(n).toLocaleString("en-US",{maximumFractionDigits:0});
const KG2LB = 2.2046226;
const CM2IN = 1/2.54;
const IN2CM = 2.54;
const CBM2FT3 = 35.3147;
/* ---- display units: storage is ALWAYS metric (kg, cm, m3); this only toggles what's shown ---- */
const UNITS_KEY = "shipsplit_units";
function getUnits(){ return localStorage.getItem(UNITS_KEY) || "kg_cm"; }
function setUnits(u){ try{ localStorage.setItem(UNITS_KEY, u); }catch(e){} }
function isImperial(){ return getUnits()==="lb_in"; }
function dispKg(kg){ return isImperial() ? (kg||0)*KG2LB : (kg||0); }
function weightUnitLabel(){ return isImperial() ? "lb" : "kg"; }
function dispCbm(cbm){ return isImperial() ? (cbm||0)*CBM2FT3 : (cbm||0); }
function volUnitLabel(){ return isImperial() ? "ft3" : "CBM"; }
function dispDimStr(dimStr){
  const d = parseDim(dimStr);
  if(!d) return dimStr||"";
  if(!isImperial()) return dimStr;
  return d.map(x=>fmt(x*CM2IN,1)).join("x");
}
function toast(msg){ const t=$("#toast"); t.classList.remove("undo"); t.textContent=msg; t.classList.add("show"); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove("show"),2600); }
/* toast with an Undo action (used instead of confirm() dialogs for deletes).
   Pending undos are a STACK: deleting twice in a row must not silently discard the first
   deletion's restore. Undo pops one at a time and re-offers the next. */
const undoStack = [];
function renderUndoToast(){
  const t=$("#toast"); clearTimeout(t._h);
  if(!undoStack.length){ t.classList.remove("show","undo"); return; }
  const top = undoStack[undoStack.length-1];
  const more = undoStack.length>1 ? ' <span class="undomore">+'+(undoStack.length-1)+' more</span>' : '';
  t.innerHTML = esc(top.msg)+more+' <button class="undobtn" id="undoBtn">Undo</button>';
  t.classList.add("show","undo");
  const btn=$("#undoBtn");
  if(btn) btn.onclick=()=>{
    const entry = undoStack.pop();
    if(entry){ try{ entry.fn(); }catch(e){} }
    if(undoStack.length) renderUndoToast(); else { t.classList.remove("show","undo"); toast("Restored"); }
  };
  t._h=setTimeout(()=>{ undoStack.length=0; t.classList.remove("show","undo"); }, 6000);
}
function showUndo(msg, restoreFn){ undoStack.push({msg, fn:restoreFn}); renderUndoToast(); }
function parseDim(s){
  if(!s) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*[xX*×]\s*(\d+(?:\.\d+)?)/);
  return m ? [parseFloat(m[1]),parseFloat(m[2]),parseFloat(m[3])] : null;
}
function cbmOf(dimStr){ const d=parseDim(dimStr); return d ? d[0]*d[1]*d[2]/1e6 : 0; }
function addDays(dateStr, days){
  if(!dateStr || days==null || days==="") return null;
  const d = new Date(dateStr+"T00:00:00");
  if(isNaN(d)) return null;
  d.setDate(d.getDate()+Number(days));
  return d;
}
function dstr(d){ return d ? d.toISOString().slice(0,10) : "-"; }

/* ================= state ================= */
const DEST_TYPES = {
  "fba-split":"Amazon FBA (split shipment)",
  "fba":"Amazon FBA (non-split)",
  "awd":"Amazon AWD",
  "wh":"Own warehouse / 3PL",
  "custom":"Custom address"
};
const MODES = {
  "air":"Air",
  "ocean-west":"Ocean - West Coast",
  "ocean-east":"Ocean - East Coast",
  "other":"Other / Express"
};
const STATUS_META = {
  "planned":{label:"Planned"},
  "booked":{label:"Booked"},
  "in-transit":{label:"In transit"},
  "arrived":{label:"Arrived"},
  "received":{label:"Received"}
};
const REF_TYPES = {
  "tracking":"Tracking #",
  "container":"Container #",
  "fba":"FBA shipment ID",
  "booking":"Booking / BOL #",
  "po":"PO / order #",                 // e.g. BN PO 02263878
  "quote":"Quote ID",                  // e.g. FedEx Quote ID 33219096
  "pickup":"Pickup confirmation #",    // e.g. SGNA2245
  "invoice":"Invoice / receipt",
  "customs":"Customs entry #",
  "other":"Other"
};
/* transient, in-memory only: which bucket ids have their tracking <details> open right now (not persisted, not saved) */
const openTracking = new Set();
const openInvoices = new Set();  // keep the invoice panel open across re-renders, same as tracking
/* transient, in-memory only: which bucket ids are collapsed/minimized to free up screen space (not saved) */
const collapsedBuckets = new Set();
/* transient: current text in the product search box (left panel filter) */
let productQuery = "";
let state = blankPlan();
function blankPlan(){
  return { planName:"", po:"", shipFrom:"", readyDate:"", notes:"", products:[], buckets:[] };
}
/* Normalize a plan coming from ANY source (saved store, WIP autosave, restored backup) so older or
   partial schemas still render instead of throwing: guard every field the renderers assume exists. */
function normalizePlan(s){
  if(!s || typeof s!=="object") return blankPlan();
  const out = Object.assign(blankPlan(), s);
  if(!Array.isArray(out.products)) out.products = [];
  if(!Array.isArray(out.buckets)) out.buckets = [];
  out.products.forEach(p=>{ if(!Array.isArray(p.cartons)) p.cartons = []; });
  out.buckets.forEach(b=>{
    if(!b.allocations || typeof b.allocations!=="object") b.allocations = {};
    if(!Array.isArray(b.refs)) b.refs = [];
    if(!b.invoice || typeof b.invoice!=="object") b.invoice = blankInvoice();
    migrateInvoice(b.invoice);
    if(b.estCustoms==null) b.estCustoms = "";
    if(b.estDuty==null) b.estDuty = "";
    if(!Array.isArray(b.files)) b.files = [];
  });
  return out;
}
/* status is optional on older saved plans; default to "planned" everywhere */
function bStatus(b){ return (b && b.status) || "planned"; }
function statusLabel(s){ return (STATUS_META[s]||STATUS_META.planned).label; }

/* products: {id, code, name, deadline, cartons:[{n, qty, dim, kg, note}]} */
/* buckets: {id, label, mode, destType, shipTo, quote, transit, allocations:{prodId:count},
             status, carrier, refs:[{type,value}], depDate, arrDate, invoice} -- all tracking optional */

/* ---- final invoice ----
   The quote is what the forwarder promised; the invoice is what they actually billed. Keeping both
   is the whole point: the gap between them is the only honest input to a landed-cost number. Charges
   are itemised because "we were $340 over" is not actionable, but "$340 of unplanned demurrage" is. */
const INVOICE_LINES = {
  freight:   "Freight",
  fuel:      "Fuel surcharge",
  customs:   "Customs clearance",
  duty:      "Duty / tariffs",
  brokerage: "Brokerage",
  lastMile:  "Last mile / delivery",
  storage:   "Storage / demurrage",
  other:     "Other",
};
const INVOICE_STATUS = { awaiting:"Awaiting invoice", received:"Invoice received", disputed:"Disputed", paid:"Paid" };
/* attachments: what a shipment document usually is, so it can be filtered later */
const FILE_KINDS = {
  invoice:"Invoice", label:"Shipping label", packing_list:"Packing list", bol:"BOL / AWB",
  customs_doc:"Customs doc", quote:"Quote", photo:"Photo", other:"Other",
};
/* files live server-side; this is just what the API last told us, keyed by shipment client id */
let shipmentFiles = {};
const openFiles = new Set();
/* The documents feature talks to the ShipSplit API (Worker + R2), which is separate from the GitHub
   plan sync. Until an API base is configured the panel still renders — it just explains that uploads
   need the backend, rather than failing silently on click. */
const API_KEY = "shipsplit-api-base";
function apiBase(){ try { return (localStorage.getItem(API_KEY)||"").replace(/\/+$/,""); } catch(e){ return ""; } }
function setApiBase(url){ try { localStorage.setItem(API_KEY, String(url||"").trim().replace(/\/+$/,"")); } catch(e){} }
function cloudOn(){ return !!apiBase(); }
async function apiFetch(path, opts){
  const base = apiBase();
  if(!base) throw new Error("no-api");
  return fetch(base+path, Object.assign({credentials:"include"}, opts||{}));
}
/* Refresh the document list for the current plan. Failures are non-fatal: documents are an extra,
   and a plan must still be usable when the API is unreachable. */
async function loadFiles(){
  if(!cloudOn() || !state.planName) return;
  try {
    const res = await apiFetch("/files?plan="+encodeURIComponent(state.planName));
    if(!res.ok) return;
    const data = await res.json();
    const byShipment = {};
    (data.files||[]).forEach(f=>{ (byShipment[f.shipmentId] = byShipment[f.shipmentId] || []).push(f); });
    shipmentFiles = byShipment;
    renderBuckets();
  } catch(e){ /* offline or not deployed yet */ }
}
async function uploadFiles(bucketId, fileList){
  if(!cloudOn()){ toast("Set the API address in Cloud settings to store documents."); return; }
  if(!state.planName){ toast("Save the plan first, then attach documents to it."); return; }
  const kindSel = document.querySelector('select[data-filekind="'+bucketId+'"]');
  const kind = kindSel ? kindSel.value : "other";
  for(const file of fileList){
    if(file.size > 25*1024*1024){ toast('"'+file.name+'" is larger than 25 MB.'); continue; }
    try {
      const res = await apiFetch("/plans/"+encodeURIComponent(state.planName)+"/files/"+encodeURIComponent(bucketId)
        + "?name="+encodeURIComponent(file.name)+"&kind="+encodeURIComponent(kind),
        { method:"POST", headers:{"Content-Type": file.type || "application/octet-stream"}, body:file });
      if(!res.ok){ const e=await res.json().catch(()=>({})); toast(e.error||("Upload failed for "+file.name)); continue; }
      toast('Attached "'+file.name+'"');
    } catch(err){ toast("Could not reach the server to upload "+file.name); }
  }
  openFiles.add(bucketId);
  await loadFiles();
}
function filesFor(bid){ return (shipmentFiles[bid] || []); }
function humanSize(n){
  if(!isFinite(n)||n<=0) return "";
  if(n < 1024) return n+" B";
  if(n < 1024*1024) return (n/1024).toFixed(0)+" KB";
  return (n/1024/1024).toFixed(1)+" MB";
}
function blankInvoice(){
  return { number:"", date:"", currency:"USD", amount:"", charges:[], status:"awaiting", paidDate:"", notes:"" };
}
/* Older saved plans stored charges as a fixed object of every possible fee. Charges are now a list
   you add to, so only fees that actually appear on the invoice are shown. Convert on load. */
function migrateInvoice(inv){
  if(!Array.isArray(inv.charges)) inv.charges = [];
  if(inv.lines && typeof inv.lines==="object"){
    Object.keys(inv.lines).forEach(code=>{
      const v = inv.lines[code];
      if(v!=="" && v!=null && Number(v)!==0 && !inv.charges.some(c=>c.code===code)){
        inv.charges.push({code, amount:String(v), note:""});
      }
    });
    delete inv.lines;
  }
  return inv;
}
function invOf(b){ if(!b.invoice) b.invoice = blankInvoice(); migrateInvoice(b.invoice); return b.invoice; }
/* Sum of the itemised charges. Used to cross-check the all-in figure, never to silently replace it —
   a forwarder's total is the number you actually pay. */
function invoiceLineTotal(b){
  return invOf(b).charges.reduce((s,c)=>s+(Number(c.amount)||0),0);
}
/* ---- the estimate side ----
   The forwarder quotes freight; customs and duty arrive separately and are usually the part that
   surprises you. Keeping them as their own estimate means the variance compares like with like
   instead of blaming freight for a duty bill nobody forecast. */
function estParts(b){
  const q = Number(b.quote)||0, c = Number(b.estCustoms)||0, d = Number(b.estDuty)||0;
  return { freight:q, customs:c, duty:d, total:q+c+d, any:(b.quote!==""&&b.quote!=null)||c>0||d>0 };
}
function estimatedTotal(b){ const e = estParts(b); return e.total>0 ? e.total : null; }
/* The billed figure: the all-in amount if entered, otherwise the itemised lines. null = not invoiced. */
function invoiceActual(b){
  const inv = invOf(b);
  const amt = Number(inv.amount);
  if(inv.amount!=="" && isFinite(amt) && amt>0) return amt;
  const lt = invoiceLineTotal(b);
  return lt>0 ? lt : null;
}
/* Estimate vs actual for one shipment. null when either side is missing — no fake zeros. */
function invoiceVariance(b){
  const q = estimatedTotal(b);
  const a = invoiceActual(b);
  if(q==null || !isFinite(q) || q<=0 || a==null) return null;
  return { quote:q, actual:a, delta:a-q, pct:((a-q)/q)*100 };
}
/* Same across every shipment in the plan, so the plan-level number only counts shipments that have
   BOTH a quote and an invoice — mixing invoiced and un-invoiced legs would understate the variance. */
function planVariance(){
  let quote=0, actual=0, n=0, pending=0;
  state.buckets.forEach(b=>{
    const v = invoiceVariance(b);
    if(v){ quote+=v.quote; actual+=v.actual; n++; }
    else if(invoiceActual(b)==null && bStatus(b)!=="planned") pending++;
  });
  return n ? { quote, actual, delta:actual-quote, pct:((actual-quote)/quote)*100, n, pending } : { n:0, pending };
}
function varianceClass(pct){ return pct>0.5 ? "over" : pct<-0.5 ? "under" : "even"; }
function varianceText(v){
  const sign = v.delta>0 ? "+" : v.delta<0 ? "−" : "";
  return sign+fmt$(Math.abs(v.delta))+" ("+sign+fmt(Math.abs(v.pct),1)+"%)";
}

/* ---- derived ---- */
function allocatedCount(p){ return state.buckets.reduce((s,b)=>s+(b.allocations[p.id]||0),0); }
/* Trim any over-allocation of a product across buckets (in bucket order) so the same physical case can
   never be booked twice. Returns how many cases had to be dropped. */
function clampAllocations(p){
  let left = p.cartons.length, cut = 0;
  state.buckets.forEach(b=>{
    const v = b.allocations[p.id];
    if(v==null) return;
    const keep = Math.max(0, Math.min(v, left));
    if(keep !== v) cut += v - keep;
    if(keep>0) b.allocations[p.id] = keep; else delete b.allocations[p.id];
    left -= keep;
  });
  return cut;
}
function remaining(p){ return p.cartons.length - allocatedCount(p); }
/* Assign actual cartons sequentially: buckets in order take slices of the product's carton list */
function cartonSlices(){
  const map = {}; // bucketId -> [{prod, cartons:[...]}]
  const cursor = {};
  state.products.forEach(p=>cursor[p.id]=0);
  state.buckets.forEach(b=>{
    map[b.id]=[];
    for(const pid in b.allocations){
      const p = state.products.find(x=>x.id===pid);
      if(!p) continue;
      const n = b.allocations[pid];
      const slice = p.cartons.slice(cursor[pid], cursor[pid]+n);
      cursor[pid]+=n;
      map[b.id].push({prod:p, cartons:slice});
    }
  });
  return map;
}
function bucketTotals(b, slices){
  const rows = slices[b.id]||[];
  let cartons=0, units=0, kg=0, cbm=0;
  rows.forEach(r=>r.cartons.forEach(c=>{ cartons++; units+=c.qty||0; kg+=c.kg||0; cbm+=cbmOf(c.dim); }));
  return {cartons, units, kg, cbm};
}
function bucketEta(b){ return addDays(state.readyDate, b.transit); }
function bucketLateProducts(b){
  const eta = bucketEta(b);
  if(!eta) return [];
  const out=[];
  for(const pid in b.allocations){
    if(!b.allocations[pid]) continue;
    const p = state.products.find(x=>x.id===pid);
    if(p && p.deadline && new Date(p.deadline+"T00:00:00") < eta) out.push(p);
  }
  return out;
}

/* ================= persistence ================= */
const LS_KEY = "shipsplit_plans_v1";
const TOMB_MAX_AGE_MS = 90*24*60*60*1000;
/* raw store includes the "__deleted__" tombstone map; loadStore() below hides it from the rest of the app */
function loadRawStore(){ try{ return JSON.parse(localStorage.getItem(LS_KEY)||"{}"); }catch(e){ return {}; } }
function loadStore(){
  const raw = loadRawStore();
  const out = {};
  for(const k in raw){ if(k==="__deleted__") continue; out[k]=raw[k]; }
  return out;
}
function saveStore(st){
  // preserve any existing tombstones so plan-only writers (savePlan, restore backup, etc.) don't erase deletion history
  const raw = loadRawStore();
  const tomb = raw.__deleted__ || {};
  const newRaw = Object.assign({}, st, {__deleted__: tomb});
  localStorage.setItem(LS_KEY, JSON.stringify(newRaw));
}
function pruneTombstones(tomb){
  const cutoff = Date.now() - TOMB_MAX_AGE_MS;
  const out = {};
  for(const n in tomb){ if((tomb[n]||0) >= cutoff) out[n]=tomb[n]; }
  return out;
}
function addTombstone(name){
  const raw = loadRawStore();
  if(!raw.__deleted__) raw.__deleted__={};
  raw.__deleted__[name] = Date.now();
  raw.__deleted__ = pruneTombstones(raw.__deleted__);
  localStorage.setItem(LS_KEY, JSON.stringify(raw));
}
/* merge rule: union of plan names; larger updatedAt wins; a plan is dropped if its tombstone is newer than its updatedAt */
function mergeStores(a, b){
  a = a||{}; b = b||{};
  const tombA = a.__deleted__||{}, tombB = b.__deleted__||{};
  const tomb = {};
  new Set([...Object.keys(tombA), ...Object.keys(tombB)]).forEach(n=>{
    tomb[n] = Math.max(tombA[n]||0, tombB[n]||0);
  });
  const names = new Set();
  for(const k in a){ if(k!=="__deleted__") names.add(k); }
  for(const k in b){ if(k!=="__deleted__") names.add(k); }
  const result = {};
  names.forEach(name=>{
    const pa = a[name], pb = b[name];
    let winner;
    if(pa && pb) winner = (Number(pb.updatedAt)||0) > (Number(pa.updatedAt)||0) ? pb : pa;
    else winner = pa || pb;
    const tombTs = tomb[name]||0;
    const winTs = (winner && Number(winner.updatedAt))||0;
    if(tombTs > winTs) return; // deletion wins
    result[name] = winner;
  });
  result.__deleted__ = pruneTombstones(tomb);
  return result;
}
function refreshPlanSelect(){
  const sel = $("#planSelect"), st = loadStore();
  sel.innerHTML = '<option value="">Saved plans...</option>' +
    Object.keys(st).sort().map(n=>`<option ${n===state.planName?"selected":""} value="${escAttr(n)}">${esc(n)}</option>`).join("");
}
function savePlan(asNew){
  let name = state.planName;
  if(asNew || !name){
    name = prompt("Plan name (e.g. PO 91+92 fall split A):", name||"");
    if(!name) return;
    state.planName = name;
  }
  const st = loadStore();
  state.updatedAt = Date.now();
  st[name] = state;
  saveStore(st);
  refreshPlanSelect(); render(); markClean();
  toast('Saved "'+name+'"');
  pushToCloud();
}
function openPlan(name){
  const st = loadStore();
  if(!st[name]) return;
  state = normalizePlan(st[name]);
  render(); markClean(); refreshPlanSelect();
  toast('Opened "'+name+'"');
}
function esc(s){ return String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function escAttr(s){ return esc(s); }

/* ================= GitHub cloud sync ================= */
const GH_KEY = "shipsplit_gh";
const GH_DEFAULTS = {owner:"joenayer", repo:"shipsplit-data", branch:"main", token:""};
let cloudState = "off"; // "off" | "on" | "error"
let cloudSha = null; // sha of plans.json in the repo, kept in memory only
let lastSyncAt = 0; // ms timestamp of the last successful cloud sync (in-memory)
function loadGhConfig(){
  try{ return Object.assign({}, GH_DEFAULTS, JSON.parse(localStorage.getItem(GH_KEY)||"null")||{}); }
  catch(e){ return Object.assign({}, GH_DEFAULTS); }
}
function saveGhConfig(cfg){ localStorage.setItem(GH_KEY, JSON.stringify(cfg)); }
function setCloudState(s){
  cloudState = s;
  const b = $("#btnCloud");
  if(b) b.textContent = s==="on" ? "Cloud: on" : s==="error" ? "Cloud: error" : "Cloud: off";
  updateSyncInfo();
}
function syncAgoText(){
  if(!lastSyncAt) return "";
  const s = Math.floor((Date.now()-lastSyncAt)/1000);
  if(s<60) return "synced just now";
  const m=Math.floor(s/60); if(m<60) return "synced "+m+"m ago";
  const h=Math.floor(m/60); if(h<24) return "synced "+h+"h ago";
  return "synced "+Math.floor(h/24)+"d ago";
}
function markSynced(){ lastSyncAt = Date.now(); updateSyncInfo(); }
function updateSyncInfo(){ const el = $("#syncInfo"); if(el) el.textContent = (cloudState==="on") ? syncAgoText() : ""; }
/* unicode-safe base64 encode; chunked to avoid stack overflow on String.fromCharCode(...bigArray) */
function b64EncodeUnicode(str){
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunkSize = 0x8000;
  for(let i=0;i<bytes.length;i+=chunkSize){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunkSize));
  }
  return btoa(binary);
}
/* unicode-safe base64 decode */
function b64DecodeUnicode(b64){
  return new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\n/g,"")), c=>c.charCodeAt(0)));
}
/* GET plans.json from the repo. 404 -> treat as empty (file not created yet). 401/403 -> authError. */
async function ghGetPlans(cfg){
  const url = "https://api.github.com/repos/"+encodeURIComponent(cfg.owner)+"/"+encodeURIComponent(cfg.repo)+"/contents/plans.json?ref="+encodeURIComponent(cfg.branch);
  const res = await fetch(url, {headers:{"Authorization":"Bearer "+cfg.token, "Accept":"application/vnd.github+json"}});
  if(res.status===404){ cloudSha=null; return {}; }
  if(res.status===401||res.status===403){ throw {authError:true}; }
  if(!res.ok){ throw new Error("GitHub GET failed: "+res.status); }
  const data = await res.json();
  cloudSha = data.sha;
  const text = b64DecodeUnicode(data.content);
  try{ return JSON.parse(text||"{}"); }catch(e){ return {}; }
}
/* PUT plans.json. On sha conflict (409/422): re-GET to refresh sha, merge, retry once. Returns the object actually written. */
async function ghPutPlans(cfg, obj){
  const url = "https://api.github.com/repos/"+encodeURIComponent(cfg.owner)+"/"+encodeURIComponent(cfg.repo)+"/contents/plans.json";
  const doPut = (payloadObj, sha)=>{
    const body = {message:"ShipSplit save "+new Date().toISOString(), content:b64EncodeUnicode(JSON.stringify(payloadObj,null,1)), branch:cfg.branch};
    if(sha) body.sha = sha;
    return fetch(url, {method:"PUT", headers:{"Authorization":"Bearer "+cfg.token, "Accept":"application/vnd.github+json", "Content-Type":"application/json"}, body:JSON.stringify(body)});
  };
  let res = await doPut(obj, cloudSha);
  if(res.status===401||res.status===403){ throw {authError:true}; }
  if(res.status===409||res.status===422){
    const cloudObj = await ghGetPlans(cfg); // refreshes cloudSha
    const merged = mergeStores(obj, cloudObj);
    res = await doPut(merged, cloudSha);
    if(res.status===401||res.status===403){ throw {authError:true}; }
    if(!res.ok){ throw new Error("GitHub PUT retry failed: "+res.status); }
    const data2 = await res.json();
    cloudSha = data2.content.sha;
    return merged;
  }
  if(!res.ok){ throw new Error("GitHub PUT failed: "+res.status); }
  const data = await res.json();
  cloudSha = data.content.sha;
  return obj;
}
function cloudErrorMessage(err){
  return (err && err.message) ? err.message : "network error";
}
/* After a merge, the plan open in the editor may now be stale. Without this, a later Save would write
   the stale in-memory copy over the newer merged one and push it back up, silently clobbering the edit
   made on another device. Adopt the newer copy when there are no unsaved edits; warn when there are. */
function reconcileOpenPlan(store){
  const name = state.planName;
  if(!name || !store || !store[name]) return;
  const incoming = store[name];
  if((Number(incoming.updatedAt)||0) <= (Number(state.updatedAt)||0)) return;
  if(planSnapshot() === lastSavedSnapshot){
    state = normalizePlan(incoming);
    render(); markClean();
    toast('Updated "'+name+'" from the cloud');
  } else {
    toast('"'+name+'" also changed on another device — use Save as to keep both.');
  }
}
/* Pull cloud plans, merge with local (raw, incl. tombstones), write result locally and (if changed) back to cloud. */
async function pullAndMerge(opts){
  opts = opts||{};
  const cfg = loadGhConfig();
  if(!cfg.token){ setCloudState("off"); return null; }
  try{
    const cloudObj = await ghGetPlans(cfg);
    const localRaw = loadRawStore();
    const merged = mergeStores(localRaw, cloudObj);
    const localJson = JSON.stringify(localRaw);
    const mergedJson = JSON.stringify(merged);
    localStorage.setItem(LS_KEY, mergedJson);
    setCloudState("on");
    reconcileOpenPlan(merged); // keep the editing session in step with what we just merged in
    if(JSON.stringify(cloudObj) !== mergedJson){
      await ghPutPlans(cfg, merged);
    }
    refreshPlanSelect();
    markSynced();
    if(!opts.quiet || localJson !== mergedJson){ toast("Cloud synced"); }
    return merged;
  }catch(err){
    if(err && err.authError){ setCloudState("error"); toast("GitHub token rejected. Open Cloud settings."); }
    else{ toast("Offline, saved locally"); }
    return null;
  }
}
/* Push local plans up after a local save/delete. Never blocks or undoes the local write; only reports the outcome. */
async function pushToCloud(){
  const cfg = loadGhConfig();
  if(!cfg.token) return;
  try{
    const localRaw = loadRawStore();
    const written = await ghPutPlans(cfg, localRaw);
    if(JSON.stringify(written) !== JSON.stringify(localRaw)){
      localStorage.setItem(LS_KEY, JSON.stringify(written));
      refreshPlanSelect();
    }
    setCloudState("on");
    markSynced();
    toast("Saved locally + cloud");
  }catch(err){
    if(err && err.authError){ setCloudState("error"); toast("GitHub token rejected. Open Cloud settings."); }
    else{ toast("Saved locally, cloud failed: "+cloudErrorMessage(err)); }
  }
}
function initCloudUI(){
  const cfg = loadGhConfig();
  if(cfg.token){
    setCloudState("on");
    pullAndMerge({quiet:false});
  } else {
    setCloudState("off");
    /* no local token: if a sync setup already exists, nudge the user to sign in (never blocking) */
    fetchSyncConfigBlob().then(blob=>{
      if(blobHasSetup(blob) && !loadGhConfig().token){ toast("Click Cloud to sign in and sync your plans"); }
    }).catch(()=>{});
  }
}

/* ================= password-unlocked token (WebCrypto, zero backend) =================
   The GitHub PAT never leaves the browser in plaintext except in the Advanced/manual flow.
   Instead, on first setup we encrypt the token with a password the user picks and store the
   encrypted blob as sync-config.json in the PUBLIC app repo (joenayer/shipsplit). Any other
   device can fetch that public (but useless-without-the-password) blob and decrypt it locally
   to recover the token, instead of the user re-pasting it. */
const APP_REPO_OWNER = "joenayer";
const APP_REPO_NAME = "shipsplit";
const APP_REPO_BRANCH = "main";
const SYNC_CONFIG_PATH = "sync-config.json";
const PBKDF2_ITERATIONS = 310000;

function ab2b64(buf){
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for(let i=0;i<bytes.length;i+=chunkSize){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunkSize));
  }
  return btoa(binary);
}
function b642ab(b64){ return Uint8Array.from(atob(b64), c=>c.charCodeAt(0)); }
async function deriveAesKey(password, salt){
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), {name:"PBKDF2"}, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name:"PBKDF2", salt, iterations:PBKDF2_ITERATIONS, hash:"SHA-256"},
    baseKey,
    {name:"AES-GCM", length:256},
    false,
    ["encrypt","decrypt"]
  );
}
/* encryptToken(token, password) -> {salt, iv, ct} all base64 (AES-256-GCM, random salt/iv, PBKDF2-SHA256/310000). */
async function encryptToken(token, password){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);
  const ctBuf = await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, new TextEncoder().encode(token));
  return {salt: ab2b64(salt), iv: ab2b64(iv), ct: ab2b64(ctBuf)};
}
/* decryptToken(blob, password) -> token string. Throws (AES-GCM auth failure) on wrong password. */
async function decryptToken(blob, password){
  const salt = b642ab(blob.salt);
  const iv = b642ab(blob.iv);
  const ct = b642ab(blob.ct);
  const key = await deriveAesKey(password, salt);
  const ptBuf = await crypto.subtle.decrypt({name:"AES-GCM", iv}, key, ct);
  return new TextDecoder().decode(ptBuf);
}
/* An email/username is only ever a lookup label. We hash it (SHA-256) so it is never written in
   plaintext to the PUBLIC setup file; the accounts map is keyed by this hash. */
function normId(s){ return String(s||"").trim().toLowerCase(); }
async function sha256hex(str){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
/* sync-config.json (v2): {v:2, accounts:{ <sha256hex(normId)>: {salt,iv,ct} }} -- one encrypted token
   per identity/password. v1 legacy was a single {v:1,salt,iv,ct} with no id; still readable below. */
function blobAccounts(blob){
  if(!blob || typeof blob!=="object") return {};
  if(blob.accounts && typeof blob.accounts==="object") return blob.accounts;
  if(blob.salt && blob.iv && blob.ct) return {__legacy__:{salt:blob.salt, iv:blob.iv, ct:blob.ct}};
  return {};
}
function blobHasSetup(blob){ return Object.keys(blobAccounts(blob)).length > 0; }

/* Session-cached lookup: undefined = not checked yet, null = confirmed absent, object = found blob. */
let _syncConfigCache;
/* Fetch sync-config.json unauthenticated from the PUBLIC app repo (raw first, api.github.com fallback). */
async function fetchSyncConfigBlob(force){
  if(!force && _syncConfigCache !== undefined) return _syncConfigCache;
  /* raw.githubusercontent.com is fast but CDN-cached: right after a fresh write it can lag or serve a
     stale 404, so a 404 here is NOT authoritative. Always confirm against the Contents API (strongly
     consistent) before concluding the setup file is absent -- otherwise a new device drops to the
     token screen even though the login exists. */
  try{
    const rawUrl = "https://raw.githubusercontent.com/"+APP_REPO_OWNER+"/"+APP_REPO_NAME+"/"+APP_REPO_BRANCH+"/"+SYNC_CONFIG_PATH;
    const res = await fetch(rawUrl, {cache:"no-store"});
    if(res.ok){ _syncConfigCache = await res.json(); return _syncConfigCache; }
    /* any non-200 (including 404): fall through to the authoritative API check below */
  }catch(e){ /* raw host unreachable; try API fallback below */ }
  try{
    const apiUrl = "https://api.github.com/repos/"+APP_REPO_OWNER+"/"+APP_REPO_NAME+"/contents/"+SYNC_CONFIG_PATH+"?ref="+APP_REPO_BRANCH;
    const res2 = await fetch(apiUrl, {headers:{"Accept":"application/vnd.github+json"}, cache:"no-store"});
    if(res2.status===404){ _syncConfigCache = null; return null; }
    if(!res2.ok){ return _syncConfigCache===undefined ? null : _syncConfigCache; }
    const data = await res2.json();
    _syncConfigCache = JSON.parse(b64DecodeUnicode(data.content));
    return _syncConfigCache;
  }catch(e){ return _syncConfigCache===undefined ? null : _syncConfigCache; }
}
/* Get sha+parsed JSON of a file in a repo (generic, used for the app-repo sync-config.json push). */
async function ghGetFileMeta(owner, repo, branch, path, token){
  const url = "https://api.github.com/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo)+"/contents/"+path+"?ref="+encodeURIComponent(branch);
  const headers = {"Accept":"application/vnd.github+json"};
  if(token) headers["Authorization"] = "Bearer "+token;
  const res = await fetch(url, {headers});
  if(res.status===404){ return {sha:null, obj:null}; }
  if(res.status===401||res.status===403){ throw {authError:true}; }
  if(!res.ok){ throw new Error("GitHub GET failed: "+res.status); }
  const data = await res.json();
  let obj = null;
  try{ obj = JSON.parse(b64DecodeUnicode(data.content)||"null"); }catch(e){ obj = null; }
  return {sha: data.sha, obj};
}
/* PUT sync-config.json to the PUBLIC app repo, authenticated with the user's own token (same sha-handling pattern as ghPutPlans). */
async function pushSyncConfigBlob(token, blob){
  const {sha} = await ghGetFileMeta(APP_REPO_OWNER, APP_REPO_NAME, APP_REPO_BRANCH, SYNC_CONFIG_PATH, token);
  const url = "https://api.github.com/repos/"+APP_REPO_OWNER+"/"+APP_REPO_NAME+"/contents/"+SYNC_CONFIG_PATH;
  const body = {message:"ShipSplit sync setup "+new Date().toISOString(), content:b64EncodeUnicode(JSON.stringify(blob,null,1)), branch:APP_REPO_BRANCH};
  if(sha) body.sha = sha;
  const res = await fetch(url, {method:"PUT", headers:{"Authorization":"Bearer "+token, "Accept":"application/vnd.github+json", "Content-Type":"application/json"}, body:JSON.stringify(body)});
  if(res.status===401||res.status===403){ throw {authError:true}; }
  if(!res.ok){ throw new Error("GitHub PUT failed: "+res.status); }
  const data = await res.json();
  _syncConfigCache = blob; // keep the session cache in sync so a later "unlock" in this tab doesn't re-fetch
  return data;
}

/* ================= xlsx import ================= */
/* Parses every sheet in the workbook (not just the first) and keeps every sheet that yields
   at least one product. If the same product code shows up in more than one sheet, the sheet
   name is appended to that product's NAME (never the code) so duplicates stay distinguishable. */
function importXlsx(file){
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const wb = XLSX.read(new Uint8Array(e.target.result), {type:"array"});
      const sheetResults = [];
      wb.SheetNames.forEach(sheetName=>{
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
        const prods = parsePackingRows(rows);
        if(prods.length) sheetResults.push({name:sheetName, rows, prods});
      });
      if(!sheetResults.length){ toast("No cases found. Is this the standard packing list format?"); return; }
      // duplicate product codes across sheets -> tag the NAME (not the code) with the sheet name
      const codeSheetCount = {};
      sheetResults.forEach(sr=>{
        new Set(sr.prods.map(p=>p.code)).forEach(c=>{ codeSheetCount[c] = (codeSheetCount[c]||0)+1; });
      });
      sheetResults.forEach(sr=>{
        sr.prods.forEach(p=>{
          if(codeSheetCount[p.code] > 1) p.name = p.name + " (" + sr.name.trim() + ")";
        });
      });
      let allProds = [];
      sheetResults.forEach(sr=>{ allProds = allProds.concat(sr.prods); });
      state.products = state.products.concat(allProds);
      // try to grab PO from the first sheet's opening rows
      for(const r of sheetResults[0].rows.slice(0,8)){
        if(r && String(r[0]||"").toLowerCase().startsWith("order")){ state.po = state.po || String(r[1]||""); }
      }
      render();
      if(sheetResults.length > 1){
        const msg = sheetResults.map(sr=>{
          const nc = sr.prods.reduce((s,p)=>s+p.cartons.length,0);
          return '"'+sr.name.trim()+'": '+sr.prods.length+' products / '+nc+' cases';
        }).join(", ");
        toast("Imported "+msg);
      } else {
        const nc = sheetResults[0].prods.reduce((s,p)=>s+p.cartons.length,0);
        toast("Imported "+sheetResults[0].prods.length+" products, "+nc+" cases");
      }
    }catch(err){ console.error(err); toast("Could not read that file: "+err.message); }
  };
  reader.readAsArrayBuffer(file);
}
function parsePackingRows(rows){
  // find header row: first cell contains "CARTON"
  let hi = rows.findIndex(r => r && String(r[0]||"").toUpperCase().includes("CARTON"));
  if(hi < 0) hi = 0;
  // fixed fallback columns (the original known-good layout: A carton, B code, C name, D qty, F dim, G kg, I note)
  let codeCol=1, nameCol=2, qtyCol=3, dimCol=5, kgCol=6, noteCol=8;
  const headerRow = rows[hi];
  if(headerRow){
    const found = {};
    headerRow.forEach((cell,ci)=>{
      const c = String(cell||"").toUpperCase();
      if(c.includes("CODE")) found.code=ci;
      if(c.includes("NAME")) found.name=ci;
      if(c.includes("Q'TY") || c.includes("QTY")) found.qty=ci;
      if(c.includes("NOTE")) found.note=ci;
    });
    // packing lists often use a two-row header: sub-headers (DIM / KG / LB) live one row below
    const subRow = rows[hi+1];
    if(subRow){
      subRow.forEach((cell,ci)=>{
        const c = String(cell||"").toUpperCase();
        if(c.includes("DIM")) found.dim=ci;
        if(c.includes("KG")) found.kg=ci;
        if(c.includes("NOTE") && found.note==null) found.note=ci;
      });
    }
    if(found.code!=null) codeCol=found.code;
    if(found.name!=null) nameCol=found.name;
    if(found.qty!=null) qtyCol=found.qty;
    if(found.dim!=null) dimCol=found.dim;
    if(found.kg!=null) kgCol=found.kg;
    if(found.note!=null) noteCol=found.note;
  }
  const prods = [];
  let cur = null, lastQty = null, lastDim = null, lastKg = null;
  for(let i=hi+1;i<rows.length;i++){
    const r = rows[i]; if(!r) continue;
    const a = r[0];
    const isNum = typeof a === "number";
    const rangeM = typeof a === "string" ? a.match(/^(\d+)\s*-\s*(\d+)$/) : null;
    if(!isNum && !rangeM){
      // stop on TOTAL rows, skip stray text rows (this also naturally skips a DIM/KG sub-header row, since its col 0 is blank)
      if(typeof a === "string" && a.toUpperCase().includes("TOTAL")) break;
      continue;
    }
    const code = r[codeCol] ? String(r[codeCol]).trim() : null;
    const name = r[nameCol] ? String(r[nameCol]).trim() : null;
    if(code){
      cur = {id:uid(), code, name:name||code, deadline:"", cartons:[]};
      prods.push(cur);
    }
    if(!cur){
      cur = {id:uid(), code:"(no code)", name:"Imported", deadline:"", cartons:[]};
      prods.push(cur);
    }
    const qty = (r[qtyCol]!=null && r[qtyCol]!=="") ? Number(r[qtyCol]) : lastQty;
    const dim = (r[dimCol]!=null && r[dimCol]!=="") ? String(r[dimCol]) : lastDim;
    const kg  = (r[kgCol]!=null && r[kgCol]!=="") ? Number(r[kgCol]) : lastKg;
    lastQty=qty; lastDim=dim; lastKg=kg;
    const note = r[noteCol] ? String(r[noteCol]) : "";
    const count = rangeM ? (parseInt(rangeM[2])-parseInt(rangeM[1])+1) : 1;
    const startN = rangeM ? parseInt(rangeM[1]) : a;
    for(let k=0;k<count;k++){
      cur.cartons.push({n:startN+k, qty:qty||0, dim:dim||"", kg:kg||0, note});
    }
  }
  return prods.filter(p=>p.cartons.length);
}

/* ================= xlsx export ================= */
function bucketSheetRows(b, slices){
  const t = bucketTotals(b, slices);
  const rows = [];
  rows.push(["PACKING LIST - " + (b.label||MODES[b.mode])]);
  rows.push(["Brand","Paper Love","","PO #", state.po||""]);
  rows.push(["Plan", state.planName||"","","Date", new Date().toISOString().slice(0,10)]);
  rows.push(["Ship from", state.shipFrom||"","","Ship to", (DEST_TYPES[b.destType]||"") + (b.shipTo? " - "+b.shipTo : "")]);
  rows.push(["Mode", MODES[b.mode]||b.mode,"","Quote", b.quote?Number(b.quote):"", "Transit days", b.transit||""]);
  rows.push(["Status", statusLabel(bStatus(b)), "", "Carrier", b.carrier||""]);
  rows.push(["Departed", b.depDate||"", "", "Arrived", b.arrDate||""]);
  (b.refs||[]).forEach(r=>{ rows.push([REF_TYPES[r.type]||r.type||"Reference", r.value||""]); });
  rows.push([]);
  rows.push(["CARTON #","ORIGINAL CTN #","PRODUCT CODE","PRODUCT NAME","QTY","DIM (CM)","GW (KG)","GW (LB)"]);
  let seq = 1;
  (slices[b.id]||[]).forEach(rr=>{
    rr.cartons.forEach(c=>{
      rows.push([seq++, c.n, rr.prod.code, rr.prod.name, c.qty, c.dim, c.kg, +(c.kg*KG2LB).toFixed(2)]);
    });
  });
  rows.push([]);
  rows.push(["TOTAL","","","", t.units,"", +t.kg.toFixed(1), +(t.kg*KG2LB).toFixed(1)]);
  rows.push(["CARTONS", t.cartons, "CBM", +t.cbm.toFixed(3)]);
  return rows;
}
function exportBucket(b){
  const slices = cartonSlices();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(bucketSheetRows(b, slices));
  ws["!cols"]=[{wch:9},{wch:13},{wch:18},{wch:26},{wch:7},{wch:13},{wch:9},{wch:9}];
  XLSX.utils.book_append_sheet(wb, ws, (b.label||"Shipment").slice(0,28).replace(/[\\/?*\[\]]/g,"-"));
  XLSX.writeFile(wb, safeName((state.planName||"plan")+" - "+(b.label||"shipment"))+".xlsx");
}
function exportAll(){
  if(!state.buckets.length){ toast("No shipments yet"); return; }
  const slices = cartonSlices();
  const wb = XLSX.utils.book_new();
  // summary sheet
  const sum = [["Plan", state.planName],["PO", state.po],["Ship from", state.shipFrom],["Cargo ready", state.readyDate],[],
    ["Shipment","Mode","Destination","Ship to","Cartons","Units","KG","CBM","Quote USD","$ / unit","Transit d","ETA"]];
  state.buckets.forEach(b=>{
    const t = bucketTotals(b, slices);
    const q = b.quote?Number(b.quote):null;
    sum.push([b.label, MODES[b.mode], DEST_TYPES[b.destType], b.shipTo||"", t.cartons, t.units, +t.kg.toFixed(1), +t.cbm.toFixed(3), q||"", (q&&t.units)?+(q/t.units).toFixed(3):"", b.transit||"", dstr(bucketEta(b))]);
  });
  const wsS = XLSX.utils.aoa_to_sheet(sum);
  wsS["!cols"]=[{wch:22},{wch:18},{wch:26},{wch:22},{wch:8},{wch:8},{wch:9},{wch:8},{wch:10},{wch:9},{wch:9},{wch:11}];
  XLSX.utils.book_append_sheet(wb, wsS, "Summary");
  const used = {};
  state.buckets.forEach((b,i)=>{
    const ws = XLSX.utils.aoa_to_sheet(bucketSheetRows(b, slices));
    ws["!cols"]=[{wch:9},{wch:13},{wch:18},{wch:26},{wch:7},{wch:13},{wch:9},{wch:9}];
    let nm = ((i+1)+" "+(b.label||"Shipment")).slice(0,28).replace(/[\\/?*\[\]]/g,"-");
    if(used[nm]) nm = nm.slice(0,25)+"_"+i; used[nm]=1;
    XLSX.utils.book_append_sheet(wb, ws, nm);
  });
  XLSX.writeFile(wb, safeName((state.planName||"plan")+" - all shipments")+".xlsx");
}
function safeName(s){ return s.replace(/[\\/:*?"<>|]/g,"-"); }
/* ---- Amazon inbound (FBA / AWD) case-pack upload sheet ----
   AWD sheet is a byte-for-byte match of the official "AWD Inbound File Upload Template V2" (Create workflow –
   template tab): prep/labeling-owner header block + the exact 12-column, case-packed header. FBA uses the same
   Send-to-Amazon case-pack fields (best-effort — column names are versioned per account). Dims in inches, weight
   in lb (US). Keys on each product's editable Amazon MSKU, falling back to its code. */
function amazonUploadUrl(program){
  return program==="AWD"
    ? "https://sellercentral.amazon.com/fba/sendtoamazon/confirm_content_step?upstream_storage=true" // AWD = upstream storage
    : "https://sellercentral.amazon.com/fba/sendtoamazon";                                           // FBA Send to Amazon
}
/* Per-SKU case-pack figures for this shipment (shared by the sheet and the prompt). */
function amazonItems(b){
  return (cartonSlices()[b.id]||[]).map(r=>{
    const p = r.prod, cs = r.cartons;
    const d = parseDim(cs[0]?cs[0].dim:"");
    return {
      msku: (p.msku && String(p.msku).trim()) || p.code,
      name: p.name||"",
      boxes: cs.length,
      unitsPerBox: cs[0] ? (cs[0].qty||0) : 0,
      totalUnits: cs.reduce((s,c)=>s+(c.qty||0),0),
      L: d? +(d[0]*CM2IN).toFixed(2) : "",
      W: d? +(d[1]*CM2IN).toFixed(2) : "",
      H: d? +(d[2]*CM2IN).toFixed(2) : "",
      wt: cs[0] ? +((cs[0].kg||0)*KG2LB).toFixed(2) : "",
      mixed: (()=>{ const u=cs[0]?cs[0].qty:0; return cs.some(c=>(c.qty||0)!==u || c.dim!==(cs[0]||{}).dim || (c.kg||0)!==((cs[0]||{}).kg||0)); })()
    };
  });
}
/* Build the sheet as an array-of-arrays (separated out so it can be unit-tested). */
function amazonSheetAoa(b, program){
  const isAWD = program==="AWD";
  const items = amazonItems(b);
  const anyMixed = items.some(i=>i.mixed);
  let aoa, cols;
  if(isAWD){
    // Exact layout of the official AWD Inbound File Upload Template V2 "Create workflow – template" tab
    cols = ["Merchant SKU","Quantity","Expiration date (MM/DD/YYYY)","Units per box ","Number of boxes","Box length (in)","Box width (in)","Box height (in)","Box weight (lb)","Palletized?","Boxes Per Pallet","Number of pallets "];
    // A1 note keeps the layout aligned with the official template (prep owner at row 3, header at row 7) —
    // leading blank rows would otherwise be dropped on write, shifting every row up.
    aoa = [ ["ShipSplit inbound — "+(state.planName||"plan")+" / "+(b.label||MODES[b.mode])], [],
      ["Default prep owner","Seller"], ["Default labeling owner","Seller"], [],
      ["Mandatory","","Optional","Mandatory","","","","","","","Mandatory if palletized",""], cols ];
    items.forEach(it=> aoa.push([it.msku, it.totalUnits, "", it.unitsPerBox, it.boxes, it.L, it.W, it.H, it.wt, "", "", ""]));
  } else {
    // FBA (Send to Amazon), case-packed — same box fields; map to your current Send to Amazon template if needed
    cols = ["Merchant SKU","Quantity","Units per box","Number of boxes","Box length (in)","Box width (in)","Box height (in)","Box weight (lb)"];
    aoa = [ ["Send to Amazon — case-packed, no pallets, no expiration dates. Confirm columns against your current Send to Amazon template. Dims in inches, weight in lb."], [],
      ["Default prep owner","Seller"], ["Default labeling owner","Seller"], [], cols ];
    items.forEach(it=> aoa.push([it.msku, it.totalUnits, it.unitsPerBox, it.boxes, it.L, it.W, it.H, it.wt]));
  }
  return {aoa, cols, isAWD, empty: !items.length, anyMixed, headerRowIndex: aoa.indexOf(cols)};
}
/* base64 of the AWD template to fill: a user-supplied one (localStorage) wins, else the embedded default */
function getAwdTemplateB64(){ try{ return localStorage.getItem("shipsplit_awd_tpl") || (window.AWD_TEMPLATE_B64||""); }catch(e){ return (window.AWD_TEMPLATE_B64||""); } }
/* Fill the OFFICIAL AWD template workbook (all tabs/metadata preserved) so Amazon accepts the upload.
   Injects one data row per SKU below the "Merchant SKU" header of the "Create workflow – template" tab. */
function fillAwdTemplate(b, items){
  const b64 = getAwdTemplateB64();
  if(!b64 || typeof XLSX==="undefined") return null;
  let wb;
  try{ wb = XLSX.read(b64, {type:"base64"}); }catch(e){ return null; }   // no cellStyles -> compact output
  let sn = wb.SheetNames.find(n=>/create workflow.*template/i.test(n));
  if(!sn){
    sn = wb.SheetNames.find(n=>{
      const g = XLSX.utils.sheet_to_json(wb.Sheets[n], {header:1, defval:null});
      return g.some(r=>r && String(r[0]||"").trim().toLowerCase()==="merchant sku");
    });
  }
  if(!sn) return null;
  const ws = wb.Sheets[sn];
  const grid = XLSX.utils.sheet_to_json(ws, {header:1, defval:null});
  let hi = grid.findIndex(r=>r && String(r[0]||"").trim().toLowerCase()==="merchant sku");
  if(hi<0) hi = 6;
  const rows = items.map(it=>[it.msku, it.totalUnits, "", it.unitsPerBox, it.boxes, it.L, it.W, it.H, it.wt, "", "", ""]);
  XLSX.utils.sheet_add_aoa(ws, rows, {origin:{r:hi+1, c:0}});
  return wb;
}
function exportAmazonSheet(b, program){
  if(!b) return;
  const isAWD = program==="AWD";
  const items = amazonItems(b);
  if(!items.length){ toast("No cases assigned to this shipment yet."); return; }
  const anyMixed = items.some(i=>i.mixed);
  const fname = safeName((state.planName||"plan")+" - "+(b.label||"shipment")+" - "+(isAWD?"AWD":"FBA")+" upload")+".xlsx";
  let wb = isAWD ? fillAwdTemplate(b, items) : null; // AWD: fill the real template so Amazon accepts it
  if(!wb){
    // FBA, or AWD template unavailable -> build the sheet from scratch
    const {aoa, cols} = amazonSheetAoa(b, program);
    wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = cols.map((c,i)=>({wch: i===0?18 : Math.max(10, String(c).length+2)}));
    XLSX.utils.book_append_sheet(wb, ws, isAWD ? "Create workflow – template" : "FBA upload");
  }
  XLSX.writeFile(wb, fname);
  toast((isAWD?"AWD":"FBA")+" sheet exported — click “Open "+(isAWD?"AWD":"FBA")+" upload” to finish on Amazon"+(anyMixed?" (some cases differ; used the first case per SKU)":""));
}
/* Deterministic, templated prompt for an agentic AI browser extension (no AI needed to build it). */
function buildShipmentPrompt(b){
  const isAWD = b.destType==="awd";
  const progName = isAWD ? "Amazon Warehousing & Distribution (AWD)" : "Amazon FBA (Send to Amazon)";
  const items = amazonItems(b);
  const url = amazonUploadUrl(isAWD?"AWD":"FBA");
  const dest = (DEST_TYPES[b.destType]||"") + (b.shipTo?" — "+b.shipTo:"");
  const p = [];
  p.push(`You are operating my Amazon Seller Central account in this browser tab. Create a new inbound shipment to ${progName} from the data below. Every item is CASE-PACKED (single-SKU boxes).`);
  p.push("");
  p.push("Context");
  p.push(`- Program: ${progName}`);
  p.push(`- Destination: ${dest}`);
  if(state.shipFrom) p.push(`- Ship from: ${state.shipFrom}`);
  p.push(`- Start page: ${url}`);
  p.push(`- Prep owner and labeling owner: Seller (default).`);
  p.push("");
  p.push(`Items (${items.length} SKU${items.length===1?"":"s"}):`);
  p.push(`| Merchant SKU | Total units | Units per box | Number of boxes | Box L x W x H (in) | Box weight (lb) |`);
  p.push(`| --- | --- | --- | --- | --- | --- |`);
  items.forEach(it=> p.push(`| ${it.msku} | ${it.totalUnits} | ${it.unitsPerBox} | ${it.boxes} | ${it.L} x ${it.W} x ${it.H} | ${it.wt} |`));
  p.push("");
  p.push("Steps");
  p.push(`1. Open the start page above in Amazon Seller Central.`);
  p.push(`2. Begin a new ${isAWD?"AWD inbound":"Send to Amazon"} workflow.`);
  p.push(`3. Add each Merchant SKU as a case-packed / boxed item using its exact units per box and number of boxes.`);
  p.push(`4. If a SKU already has a saved case/box template for that units-per-box quantity, select and reuse the existing template — do NOT create a new one or edit its dimensions. Only when no matching template exists, enter the box dimensions (inches) and weight (pounds) as listed above.`);
  p.push(`5. Set prep owner = Seller and labeling owner = Seller. No Amazon barcode labels should be needed — the products use the manufacturer barcode. If any SKU requires Amazon (FNSKU) barcode labeling, stop and flag it instead of proceeding.`);
  p.push(`6. STOP at the final review screen — do NOT submit or confirm. Summarize what you entered, and flag any Merchant SKU not found in my catalog, so I can verify before submitting myself.`);
  return p.join("\n");
}
function openPromptModal(b){
  if(!b) return;
  if(!amazonItems(b).length){ toast("No cases assigned to this shipment yet."); return; }
  const program = b.destType==="awd" ? "AWD" : "FBA";
  $("#promptTitle").textContent = "Create "+program+" shipment prompt — "+(b.label||MODES[b.mode]);
  $("#promptText").value = buildShipmentPrompt(b);
  $("#promptOverlay").classList.add("show");
  setTimeout(()=>{ const ta=$("#promptText"); if(ta){ ta.focus(); ta.select(); ta.scrollTop=0; } }, 50);
}

/* ================= render ================= */
/* dirty indicator: has the plan changed since it was last saved/opened this session? */
function planSnapshot(){ return JSON.stringify({planName:state.planName, po:state.po, shipFrom:state.shipFrom, readyDate:state.readyDate, notes:state.notes, products:state.products, buckets:state.buckets}); }
let lastSavedSnapshot = "";
function markClean(){ lastSavedSnapshot = planSnapshot(); updateSaveIndicator(); }
function updateSaveIndicator(){
  const b = $("#btnSave"); if(!b) return;
  const dirty = planSnapshot() !== lastSavedSnapshot;
  b.classList.toggle("dirty", dirty);
  b.title = dirty ? "You have unsaved changes — click to save" : "Plan saved";
}
function render(){
  // plan bar
  $("#fPlanName").value = state.planName||"";
  $("#fPo").value = state.po||"";
  $("#fShipFrom").value = state.shipFrom||"";
  $("#fReady").value = state.readyDate||"";
  $("#fNotes").value = state.notes||"";
  $("#fUnits").value = getUnits();
  renderProducts();
  renderBuckets();
  renderSummary();
  updateSaveIndicator();
}
/* Re-rendering a panel replaces its innerHTML, which drops focus — and worse, if the user has already
   tabbed or clicked into the NEXT field when the previous one commits, that field is destroyed
   mid-typing and keystrokes are lost. Capture the focused control by its data-* attribute (plus its
   index, since L/W/H share one attribute) and restore it after the re-render. */
function cssEsc(v){ return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g,"\\$&"); }
function captureFocus(container){
  const el = document.activeElement;
  if(!el || !container || !container.contains(el)) return null;
  const attr = [].slice.call(el.attributes).find(a=>a.name.indexOf("data-")===0);
  if(!attr) return null;
  const sel = "["+attr.name+'="'+cssEsc(attr.value)+'"]';
  const idx = [].slice.call(document.querySelectorAll(sel)).indexOf(el);
  let range = null;
  try{ range = {s:el.selectionStart, e:el.selectionEnd}; }catch(e){}
  return {sel, idx: idx<0?0:idx, range};
}
function restoreFocus(cap){
  if(!cap) return;
  const list = document.querySelectorAll(cap.sel);
  const el = list[cap.idx] || list[0];
  if(!el) return;
  el.focus();
  if(cap.range && cap.range.s!=null){ try{ el.setSelectionRange(cap.range.s, cap.range.e); }catch(e){} }
}
function renderProducts(){
  const cap = captureFocus($("#prodList"));
  renderProductsInner();
  restoreFocus(cap);
}
function renderProductsInner(){
  const box = $("#prodList");
  const search = $("#prodSearch");
  if(search) search.style.display = state.products.length ? "" : "none";
  if(!state.products.length){
    box.innerHTML = '<div class="hint" style="padding:6px 2px">No products yet. Import a packing list above or add manually below.</div>';
    $("#unassignedInfo").textContent = "";
    return;
  }
  // totals always cover ALL products; the list below may be narrowed by the search box
  let totLeft=0, totCases=0;
  state.products.forEach(p=>{ totLeft+=remaining(p); totCases+=p.cartons.length; });
  const q = (productQuery||"").trim().toLowerCase();
  const shown = q ? state.products.filter(p=>((p.code||"")+" "+(p.name||"")).toLowerCase().includes(q)) : state.products;
  if(!shown.length){
    box.innerHTML = '<div class="hint" style="padding:6px 2px">No products match "'+esc(q)+'".</div>';
  } else {
    const unit = isImperial()?"in":"cm";
    box.innerHTML = shown.map(p=>{
      const left = remaining(p);
      const kg = p.cartons.reduce((s,c)=>s+(c.kg||0),0);
      const cbm = p.cartons.reduce((s,c)=>s+cbmOf(c.dim),0);
      const units = p.cartons.reduce((s,c)=>s+(c.qty||0),0);
      const dims = p.cartons.map(c=>c.dim).filter(Boolean);
      const uniform = dims.length>0 && dims.every(d=>d===dims[0]);
      // per-case editable values (assume uniform; show the first case's numbers)
      const c0 = p.cartons[0]||{};
      // editing units/case or kg/case overwrites EVERY case, so warn when they currently differ
      const mixedQty = p.cartons.length>1 && p.cartons.some(c=>(c.qty||0)!==(p.cartons[0].qty||0));
      const mixedKg  = p.cartons.length>1 && p.cartons.some(c=>(c.kg||0)!==(p.cartons[0].kg||0));
      const qty0 = c0.qty!=null ? c0.qty : "";
      const kg0 = c0.kg!=null ? +(dispKg(c0.kg)).toFixed(2) : "";
      const d0 = parseDim(dims[0]||"");
      const dv = d0 ? (isImperial()? d0.map(x=>String(+(x*CM2IN).toFixed(1))) : d0.map(x=>String(x))) : ["","",""];
      return `<div class="prod ${left===0?"done":""}" draggable="true" data-pid="${p.id}">
        <button class="del" title="Remove product" aria-label="Remove product" data-delprod="${p.id}">✕</button>
        <input class="pcode" data-pcode="${p.id}" value="${escAttr(p.code)}" title="Product code" spellcheck="false">
        <input class="pname" data-pname="${p.id}" value="${escAttr(p.name)}" placeholder="Product name" title="Product name">
        <div class="meta"><span><b>${p.cartons.length}</b> cases</span><span><b>${fmt(units,0)}</b> units</span><span><b>${fmt(dispKg(kg),0)}</b> ${weightUnitLabel()}</span><span><b>${fmt(dispCbm(cbm),2)}</b> ${volUnitLabel()}</span></div>
        <div class="pedit">
          <label title="Units in each case">units/case <input type="number" min="0" data-pqty="${p.id}" value="${escAttr(qty0)}">${mixedQty?'<span class="hint" title="Cases currently hold different quantities; editing sets them all the same">mixed</span>':''}</label>
          <label title="Weight of each case">${weightUnitLabel()}/case <input type="number" min="0" step="0.1" data-pkg="${p.id}" value="${escAttr(kg0)}">${mixedKg?'<span class="hint" title="Cases currently have different weights; editing sets them all the same">mixed</span>':''}</label>
        </div>
        <div class="pmsku"><label title="Amazon Merchant SKU used on the FBA/AWD upload sheets — leave blank to use the code above">Amazon MSKU <input data-pmsku="${p.id}" value="${escAttr(p.msku||"")}" placeholder="${escAttr(p.code)}" spellcheck="false"></label></div>
        <div class="pdimrow">
          <label>case (${unit})</label>
          <input data-pdim="${p.id}" value="${escAttr(dv[0])}" placeholder="L" title="Length — applies to all ${p.cartons.length} cases" inputmode="decimal">
          <span class="x">×</span>
          <input data-pdim="${p.id}" value="${escAttr(dv[1])}" placeholder="W" title="Width — applies to all ${p.cartons.length} cases" inputmode="decimal">
          <span class="x">×</span>
          <input data-pdim="${p.id}" value="${escAttr(dv[2])}" placeholder="H" title="Height — applies to all ${p.cartons.length} cases" inputmode="decimal">
          ${dims.length && !uniform ? '<span class="hint" title="Cases currently have different sizes; editing sets them all the same">mixed</span>' : ''}
        </div>
        <div class="row2">
          <span class="badge ${left===0?"zero":"left"}">${p.cartons.length===0?"no cases":left===0?"fully assigned":left+" cases unassigned"}</span>
          <label class="hint" title="Must arrive by">need by <input type="date" data-deadline="${p.id}" value="${escAttr(p.deadline||"")}"></label>
        </div>
        <div class="prow-actions">
          <button class="btn assign" data-assign="${p.id}">Assign →</button>
          <button class="btn assign" data-split="${p.id}" title="Distribute this product's cases evenly across all shipments">Split evenly ⇄</button>
        </div>
      </div>`;
    }).join("");
  }
  $("#unassignedInfo").textContent = totLeft>0 ? totLeft+" of "+totCases+" cases unassigned" : "all "+totCases+" cases assigned";
}
function updateCollapseAllLabel(){
  const qs = $("#btnQuickStart"); if(qs) qs.style.display = state.buckets.length ? "none" : "";
  const btn = $("#btnCollapseAll"); if(!btn) return;
  const ids = state.buckets.map(b=>b.id);
  btn.style.display = ids.length>1 ? "" : "none";
  const allCollapsed = ids.length>0 && ids.every(id=>collapsedBuckets.has(id));
  btn.textContent = allCollapsed ? "Expand all" : "Collapse all";
}
function renderBuckets(){
  const cap = captureFocus($("#bucketGrid"));
  renderBucketsInner();
  restoreFocus(cap);
}
function renderBucketsInner(){
  const grid = $("#bucketGrid");
  updateCollapseAllLabel();
  const slices = cartonSlices();
  if(!state.buckets.length){
    grid.innerHTML = '<div class="hint" style="padding:20px;border:2px dashed var(--line);border-radius:10px">No shipments yet. Use <b>Quick start</b> to create Air + Ocean West + Ocean East at once, or "+ Add shipment" for one.</div>';
    return;
  }
  grid.innerHTML = state.buckets.map((b,bi)=>{
    const t = bucketTotals(b, slices);
    const q = b.quote?Number(b.quote):null;
    const eta = bucketEta(b);
    const late = bucketLateProducts(b);
    const allocRows = Object.keys(b.allocations).filter(pid=>b.allocations[pid]>0).map(pid=>{
      const p = state.products.find(x=>x.id===pid); if(!p) return "";
      const sl = (slices[b.id]||[]).find(r=>r.prod.id===pid);
      const skg = sl? sl.cartons.reduce((s,c)=>s+(c.kg||0),0):0;
      const su = sl? sl.cartons.reduce((s,c)=>s+(c.qty||0),0):0;
      const scbm = sl? sl.cartons.reduce((s,c)=>s+cbmOf(c.dim),0):0;
      const isLate = late.some(x=>x.id===pid);
      return `<tr>
        <td ${isLate?'class="late-cell" title="Arrives after need-by date"':''}>${esc(p.code)}${isLate?" ⚠":""}</td>
        <td class="num"><input type="number" class="cnt" min="0" max="${p.cartons.length}" value="${escAttr(b.allocations[pid])}" data-alloc="${b.id}|${pid}"></td>
        <td class="num">${fmt(su,0)}</td>
        <td class="num">${fmt(dispKg(skg),0)}</td>
        <td class="num">${fmt(dispCbm(scbm),2)}</td>
        <td><button class="rm" title="Remove ${escAttr(p.code)} from this shipment" aria-label="Remove ${escAttr(p.code)} from this shipment" data-rmalloc="${b.id}|${pid}">✕</button></td>
      </tr>`;
    }).join("");
    const st = bStatus(b);
    const collapsed = collapsedBuckets.has(b.id);
    // Amazon inbound upload sheet offered based on the destination: AWD -> AWD sheet, FBA (split/non-split) -> FBA sheet
    const amz = b.destType==="awd" ? "AWD" : (b.destType==="fba-split"||b.destType==="fba") ? "FBA" : "";
    return `<div class="bucket mode-${b.mode}${collapsed?" collapsed":""}" data-bucket="${b.id}">
      <div class="bucket-h">
        <button class="bcollapse" data-collapse="${b.id}" title="${collapsed?"Expand shipment":"Minimize shipment"}" aria-label="${collapsed?"Expand shipment":"Minimize shipment"}">${collapsed?"▸":"▾"}</button>
        <span class="modechip ${b.mode}">${MODES[b.mode]||b.mode}</span>
        ${st!=="planned"?`<span class="statuschip ${st}">${statusLabel(st)}</span>`:""}
        <input class="label" value="${escAttr(b.label||"")}" placeholder="Shipment name" data-blabel="${b.id}">
        <button class="movebtn" data-moveup="${b.id}" title="Move up" aria-label="Move shipment up"${bi===0?' style="visibility:hidden"':''}>▲</button>
        <button class="movebtn" data-movedown="${b.id}" title="Move down" aria-label="Move shipment down"${bi===state.buckets.length-1?' style="visibility:hidden"':''}>▼</button>
        <button class="rm" title="Delete shipment" aria-label="Delete shipment" data-delbucket="${b.id}" style="border:none;background:none;color:#b9c4d0;cursor:pointer">✕</button>
      </div>
      ${collapsed ? `<div class="bucket-collapsed"><span>${t.cartons} cases · ${fmt(t.units,0)} units · ${fmt(dispKg(t.kg),0)} ${weightUnitLabel()} · ${fmt(dispCbm(t.cbm),2)} ${volUnitLabel()}${q?` · ${fmt$(q)}`:""}${eta?` · ETA ${dstr(eta)}`:""}</span>${late.length?`<span class="late-cell">⚠ late</span>`:""}</div>` : `
      <div class="bucket-fields">
        <div class="field"><label>Mode</label>
          <select data-bmode="${b.id}">${Object.keys(MODES).map(m=>`<option value="${m}" ${m===b.mode?"selected":""}>${MODES[m]}</option>`).join("")}</select></div>
        <div class="field"><label>Destination type</label>
          <select data-bdest="${b.id}">${Object.keys(DEST_TYPES).map(d=>`<option value="${d}" ${d===b.destType?"selected":""}>${DEST_TYPES[d]}</option>`).join("")}</select></div>
        <div class="field wide"><label>Ship to (name / address / FC code)</label><input data-bshipto="${b.id}" value="${escAttr(b.shipTo||"")}" placeholder="e.g. AWD IUSP, or 3PL address"></div>
        <div class="field"><label>Freight quote (USD)</label><input type="number" data-bquote="${b.id}" value="${escAttr(b.quote||"")}" placeholder="from forwarder"></div>
        <div class="field"><label>Transit days (door to door)</label><input type="number" data-btransit="${b.id}" value="${escAttr(b.transit||"")}" placeholder="e.g. 38"></div>
        <div class="field"><label>Est. customs (USD)</label><input type="number" step="0.01" data-bestcustoms="${b.id}" value="${escAttr(b.estCustoms||"")}" placeholder="clearance"></div>
        <div class="field"><label>Est. duty / tariffs (USD)</label><input type="number" step="0.01" data-bestduty="${b.id}" value="${escAttr(b.estDuty||"")}" placeholder="expected"></div>
        ${(()=>{ const e=estParts(b); return (e.customs||e.duty) ? `<div class="esttotal">Estimated total <b>${fmt$(e.total)}</b> <span class="hint">freight ${fmt$(e.freight)} + customs ${fmt$(e.customs)} + duty ${fmt$(e.duty)}</span></div>` : ""; })()}
      </div>
      <div class="alloc">
        ${allocRows ? `<table><thead><tr><th>Product</th><th class="num">Cases</th><th class="num">Units</th><th class="num">${weightUnitLabel().toUpperCase()}</th><th class="num">${volUnitLabel()}</th><th></th></tr></thead><tbody>${allocRows}</tbody></table>` : `<div class="dropzone-empty">Drag a product here, or add a new one below</div>`}
        <div style="padding:6px 0 2px"><button class="btn small" data-addprodto="${b.id}">+ New product to this shipment</button></div>
      </div>
      ${(()=>{
        const inv = invOf(b), v = invoiceVariance(b), lt = invoiceLineTotal(b), amt = Number(inv.amount)||0;
        const mismatch = inv.amount!=="" && lt>0 && Math.abs(lt-amt) > 0.5;
        return `<details class="invoice" data-invid="${b.id}" ${openInvoices.has(b.id)?"open":""}>
        <summary>Final invoice${v?` <span class="varchip ${varianceClass(v.pct)}">${varianceText(v)} vs estimate</span>`:inv.status!=="awaiting"?` <span class="varchip even">${INVOICE_STATUS[inv.status]}</span>`:""}</summary>
        <div class="invfields">
          <div class="field"><label>Invoice status</label>
            <select data-invstatus="${b.id}">${Object.keys(INVOICE_STATUS).map(s=>`<option value="${s}" ${s===inv.status?"selected":""}>${INVOICE_STATUS[s]}</option>`).join("")}</select></div>
          <div class="field"><label>Invoice number</label><input data-invnum="${b.id}" value="${escAttr(inv.number||"")}" placeholder="from forwarder"></div>
          <div class="field"><label>Invoice date</label><input type="date" data-invdate="${b.id}" value="${escAttr(inv.date||"")}"></div>
          <div class="field"><label>Final total (${escAttr(inv.currency||"USD")}, all-in)</label><input type="number" step="0.01" data-invamt="${b.id}" value="${escAttr(inv.amount||"")}" placeholder="as billed"></div>
          <div class="field"><label>Date paid</label><input type="date" data-invpaid="${b.id}" value="${escAttr(inv.paidDate||"")}"></div>
        </div>
        <div class="invlines">
          <label class="invlbl">Charges on this invoice</label>
          ${inv.charges.length ? inv.charges.map((c,i)=>`<div class="chargerow">
            <select data-chargecode="${b.id}|${i}">${Object.keys(INVOICE_LINES).map(k=>`<option value="${k}" ${k===c.code?"selected":""}>${INVOICE_LINES[k]}</option>`).join("")}</select>
            <input type="number" step="0.01" data-chargeamt="${b.id}|${i}" value="${escAttr(c.amount||"")}" placeholder="0.00">
            <button class="rm" title="Remove this charge" aria-label="Remove this charge" data-rmcharge="${b.id}|${i}">✕</button>
          </div>`).join("") : `<div class="hint" style="padding:2px 0 6px">No charges itemised. Add the ones that appear on the invoice.</div>`}
          <button class="btn small" data-addcharge="${b.id}">+ Add fee</button>
          ${lt>0?`<div class="invsum${mismatch?" mismatch":""}">Charges total ${fmt$(lt)}${inv.amount!==""?` · all-in ${fmt$(amt)}${mismatch?` · differs by ${fmt$(Math.abs(lt-amt))}`:" · matches"}`:""}</div>`:""}
        </div>
        <div class="field wide"><label>Invoice notes</label><input data-invnotes="${b.id}" value="${escAttr(inv.notes||"")}" placeholder="e.g. 3 days demurrage at Ningbo"></div>
        ${v?(()=>{ const e=estParts(b); return `<div class="invcompare">
          <span>Estimated <b>${fmt$(v.quote)}</b>${(e.customs||e.duty)?`<span class="hint"> (incl. customs + duty)</span>`:""}</span>
          <span>Billed <b>${fmt$(v.actual)}</b></span>
          <span class="varchip ${varianceClass(v.pct)}">${varianceText(v)}</span>
          ${t.units?`<span class="hint">${fmt(v.actual/t.units,3)} $/unit actual</span>`:""}
        </div>`; })():""}
      </details>`;
      })()}
      ${(()=>{
        const list = filesFor(b.id);
        return `<details class="files-panel" data-filesid="${b.id}" ${openFiles.has(b.id)?"open":""}>
        <summary>Documents${list.length?` <span class="varchip even">${list.length}</span>`:""}</summary>
        <div class="files">
          ${list.map(f=>`<div class="filerow">
            <span class="filekind">${FILE_KINDS[f.kind]||f.kind}</span>
            <a class="fname" href="#" data-dlfile="${escAttr(f.id)}" title="${escAttr(f.fileName)}">${esc(f.fileName)}</a>
            <span class="fmeta">${humanSize(f.size)}</span>
            <button class="rm" title="Remove document" aria-label="Remove document" data-rmfile="${escAttr(f.id)}|${b.id}">✕</button>
          </div>`).join("")}
          <div class="field"><label>Type of document</label>
            <select data-filekind="${b.id}">${Object.keys(FILE_KINDS).map(k=>`<option value="${k}">${FILE_KINDS[k]}</option>`).join("")}</select></div>
          <div class="filedrop" data-filedrop="${b.id}">Drop a file here, or click to choose — invoice, label, packing list, anything worth keeping</div>
          <input type="file" data-fileinput="${b.id}" style="display:none" multiple>
          ${cloudOn() ? "" : `<div class="hint" style="margin-top:6px">Documents upload once cloud sync is switched on.</div>`}
        </div>
      </details>`;
      })()}
      <details class="tracking" data-trackid="${b.id}" ${openTracking.has(b.id)?"open":""}>
        <summary>Tracking and status</summary>
        <div class="trackfields">
          <div class="field"><label>Status</label>
            <select class="statuschip ${st}" data-bstatus="${b.id}">${Object.keys(STATUS_META).map(s=>`<option value="${s}" ${s===st?"selected":""}>${STATUS_META[s].label}</option>`).join("")}</select>
          </div>
          <div class="field"><label>Carrier / forwarder</label><input data-bcarrier="${b.id}" value="${escAttr(b.carrier||"")}" placeholder="e.g. Flexport, DHL"></div>
          <div class="field"><label>Actual departure</label><input type="date" data-bdep="${b.id}" value="${escAttr(b.depDate||"")}"></div>
          <div class="field"><label>Actual arrival</label><input type="date" data-barr="${b.id}" value="${escAttr(b.arrDate||"")}"></div>
        </div>
        <div class="refs">
          <label style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">References</label>
          ${(b.refs||[]).map((r,i)=>{
            const showLink = r.value && /^https?:\/\//i.test(r.value);
            return `<div class="refrow">
              <select data-reftype="${b.id}|${i}">${Object.keys(REF_TYPES).map(rt=>`<option value="${rt}" ${rt===r.type?"selected":""}>${REF_TYPES[rt]}</option>`).join("")}</select>
              <input data-refval="${b.id}|${i}" value="${escAttr(r.value||"")}" placeholder="value">
              ${showLink?`<a class="reflink" href="${escAttr(r.value)}" target="_blank" rel="noopener">open</a>`:""}
              <button class="rm" title="Remove reference" aria-label="Remove reference" data-rmref="${b.id}|${i}">✕</button>
            </div>`;
          }).join("")}
          <button class="btn small" data-addref="${b.id}">+ Add reference</button>
        </div>
      </details>
      <div class="bucket-f">
        <div class="totline">
          <span><b>${t.cartons}</b> cases</span><span><b>${fmt(t.units,0)}</b> units</span>
          <span><b>${fmt(dispKg(t.kg),0)}</b> ${weightUnitLabel()}</span><span><b>${fmt(dispCbm(t.cbm),2)}</b> ${volUnitLabel()}</span>
        </div>
        <div class="totline" style="margin-top:3px">
          <span>Quote: <b>${fmt$(q)}</b></span>
          ${q&&t.kg?`<span>${fmt(q/dispKg(t.kg),2)} $/${weightUnitLabel()}</span>`:""}
          ${q&&t.cbm?`<span>${fmt(q/dispCbm(t.cbm),0)} $/${volUnitLabel()}</span>`:""}
          ${q&&t.units?`<span><b>${fmt(q/t.units,3)}</b> $/unit</span>`:""}
        </div>
        <div class="eta">ETA: <b>${eta?dstr(eta):"set ready date + transit"}</b>${eta&&!late.length?' <span class="ok">on time for all deadlines set</span>':""}</div>
        ${late.length?`<div class="warnflag">⚠ Arrives after need-by date: ${late.map(p=>esc(p.code)).join(", ")}. Consider moving those cases to a faster shipment.</div>`:""}
        <div class="bucket-actions"><button class="btn small" data-savebucket="${b.id}" title="Save the whole plan now so this shipment's changes aren't lost">Save</button><button class="btn small" data-dupbucket="${b.id}" title="Create a copy with the same settings and no cases">Duplicate</button><button class="btn small" data-export="${b.id}">Export packing list</button>${amz?`<button class="btn small amzbtn" data-amzsheet="${b.id}|${amz}" title="Download a case-packed ${amz} inbound upload sheet for this shipment">Export ${amz} sheet</button><a class="btn small amzlink" href="${amazonUploadUrl(amz)}" target="_blank" rel="noopener" title="Open Amazon Seller Central to upload the ${amz} sheet">Open ${amz} upload ↗</a><button class="btn small amzprompt" data-prompt="${b.id}" title="Generate a ready-to-paste prompt for an AI browser extension to create this shipment on Amazon">Create prompt ✨</button>`:""}</div>
      </div>
      `}
    </div>`;
  }).join("");
}
function planProgressText(){
  const total = state.buckets.length;
  if(!total) return "";
  const anyProgress = state.buckets.some(b=>bStatus(b)!=="planned");
  if(!anyProgress) return "";
  const received = state.buckets.filter(b=>bStatus(b)==="received").length;
  return received+" of "+total+" shipments received";
}
function renderSummary(){
  const body = $("#summaryBody");
  const pp = $("#planProgress");
  if(pp) pp.textContent = planProgressText();
  const slices = cartonSlices();
  if(!state.buckets.length){ body.innerHTML='<span class="hint">Add shipments to see the comparison.</span>'; return; }
  // precompute per-bucket $/unit (to flag the cheapest) and per-mode subtotals
  const perUnit = {};
  const modeAgg = {};
  let bestId = null, bestVal = Infinity;
  state.buckets.forEach(b=>{
    const t = bucketTotals(b, slices);
    const q = b.quote?Number(b.quote):null;
    const pu = (q && t.units) ? q/t.units : null;
    perUnit[b.id] = pu;
    if(pu!=null && pu < bestVal){ bestVal = pu; bestId = b.id; }
    const m = modeAgg[b.mode] || (modeAgg[b.mode]={cases:0,units:0,quote:0,hasQ:false});
    m.cases+=t.cartons; m.units+=t.units; if(q){ m.quote+=q; m.hasQ=true; }
  });
  let Tc=0,Tu=0,Tk=0,Tv=0,Tq=0, anyQ=false, Ta=0, anyA=false;
  const rows = state.buckets.map(b=>{
    const t = bucketTotals(b, slices);
    const q = b.quote?Number(b.quote):null;
    if(q){Tq+=q; anyQ=true;}
    const act = invoiceActual(b); if(act!=null){ Ta+=act; anyA=true; }
    Tc+=t.cartons;Tu+=t.units;Tk+=t.kg;Tv+=t.cbm;
    const late = bucketLateProducts(b);
    const st = bStatus(b);
    const pu = perUnit[b.id];
    const isBest = b.id===bestId && state.buckets.length>1;
    return `<tr class="${st==='received'?'muted-row':''}">
      <td><b>${esc(b.label||MODES[b.mode])}</b></td><td>${MODES[b.mode]}</td>
      <td>${DEST_TYPES[b.destType]||""}${b.shipTo?"<br><span class='hint'>"+esc(b.shipTo)+"</span>":""}</td>
      <td><span class="statuschip ${st}">${statusLabel(st)}</span></td>
      <td class="num">${t.cartons}</td><td class="num">${fmt(t.units,0)}</td>
      <td class="num">${fmt(dispKg(t.kg),0)}</td><td class="num">${fmt(dispCbm(t.cbm),2)}</td>
      <td class="num">${fmt$(q)}</td>
      <td class="num">${act!=null?fmt$(act):"<span class='hint'>pending</span>"}</td>
      <td class="num">${(()=>{ const v=invoiceVariance(b); return v?`<span class="varchip ${varianceClass(v.pct)}">${varianceText(v)}</span>`:"-"; })()}</td>
      <td class="num ${isBest?"bestcell":""}"${isBest?' title="Cheapest per unit"':''}>${pu!=null?fmt(pu,3)+(isBest?" ✓":""):"-"}</td>
      <td class="num">${b.transit||"-"}</td>
      <td class="${late.length?"late-cell":""}">${dstr(bucketEta(b))}${late.length?" ⚠":""}${b.arrDate?`<div class="hint">arr ${esc(b.arrDate)}</div>`:""}</td>
    </tr>`;
  }).join("");
  const un = state.products.reduce((s,p)=>s+remaining(p),0);
  const modes = Object.keys(modeAgg);
  const byMode = modes.length>1 ? `<div class="bymode">${modes.map(m=>{
    const a = modeAgg[m];
    const blended = (a.hasQ && a.units) ? " · "+fmt(a.quote/a.units,3)+" $/unit" : "";
    return `<span><b>${MODES[m]}</b>: ${a.cases} cases · ${fmt(a.units,0)} units${a.hasQ?" · "+fmt$(a.quote):""}${blended}</span>`;
  }).join("")}</div>` : "";
  body.innerHTML = `<div style="overflow:auto"><table>
    <thead><tr><th>Shipment</th><th>Mode</th><th>Destination</th><th>Status</th><th class="num">Cases</th><th class="num">Units</th><th class="num">${weightUnitLabel().toUpperCase()}</th><th class="num">${volUnitLabel()}</th><th class="num">Quote</th><th class="num">Billed</th><th class="num">Variance</th><th class="num">$/unit</th><th class="num">Transit</th><th>ETA</th></tr></thead>
    <tbody>${rows}
    <tr class="total"><td>Total plan</td><td></td><td></td><td></td><td class="num">${Tc}</td><td class="num">${fmt(Tu,0)}</td><td class="num">${fmt(dispKg(Tk),0)}</td><td class="num">${fmt(dispCbm(Tv),2)}</td><td class="num">${anyQ?fmt$(Tq):"-"}</td><td class="num">${anyA?fmt$(Ta):"-"}</td><td class="num">${(()=>{
      const pv=planVariance();
      if(!pv.n) return "-";
      /* The Quote column above totals EVERY shipment, but variance can only compare the ones that
         have both a quote and an invoice. Say so, or the row looks like it cannot do arithmetic. */
      const partial = pv.n < state.buckets.length;
      return `<span class="varchip ${varianceClass(pv.pct)}"${partial?` title="Compares the ${pv.n} shipment${pv.n>1?"s":""} that have both a quote and an invoice — not the full plan total to the left"`:""}>${varianceText(pv)}</span>${partial?`<div class="hint" style="font-weight:400">on ${pv.n} of ${state.buckets.length}</div>`:""}`;
    })()}</td><td class="num">${anyQ&&Tu?fmt(Tq/Tu,3):"-"}</td><td></td><td></td></tr>
    </tbody></table></div>
    ${byMode}
    ${(()=>{
      const pv = planVariance();
      if(!pv.n) return pv.pending ? `<div class="hint" style="margin-top:8px">${pv.pending} shipment${pv.pending>1?"s":""} in progress with no invoice entered yet.</div>` : "";
      const dir = pv.delta>0 ? "over" : pv.delta<0 ? "under" : "on";
      return `<div class="varbanner ${varianceClass(pv.pct)}">
        <b>Estimate vs final invoice</b> — ${pv.n} invoiced shipment${pv.n>1?"s":""}:
        quoted ${fmt$(pv.quote)}, billed ${fmt$(pv.actual)},
        <b>${dir==="on"?"on estimate":varianceText(pv)+" "+dir}</b>${pv.pending?` · ${pv.pending} still awaiting an invoice`:""}
      </div>`;
    })()}
    ${un>0?`<div class="warnflag" style="margin-top:8px">⚠ ${un} cases are not assigned to any shipment yet.</div>`:""}`;
}

/* ================= events ================= */
// plan bar
[["fPlanName","planName"],["fPo","po"],["fShipFrom","shipFrom"],["fReady","readyDate"],["fNotes","notes"]].forEach(([id,key])=>{
  $("#"+id).addEventListener("input", e=>{ state[key]=e.target.value; if(key==="readyDate"){renderBuckets();renderSummary();} });
});
// header buttons
$("#btnSave").onclick = ()=>savePlan(false);
$("#btnSaveAs").onclick = ()=>savePlan(true);
$("#btnNew").onclick = ()=>{ if(confirm("Start a new empty plan? Unsaved changes are lost.")){ state=blankPlan(); productQuery=""; if($("#prodSearch")) $("#prodSearch").value=""; render(); markClean(); refreshPlanSelect(); } };
$("#btnDeletePlan").onclick = ()=>{
  const name = $("#planSelect").value || state.planName;
  if(!name){ toast("No saved plan selected"); return; }
  if(!confirm('Delete saved plan "'+name+'"?')) return;
  const st = loadStore(); delete st[name]; saveStore(st); addTombstone(name); refreshPlanSelect(); toast("Deleted");
  pushToCloud();
};
$("#planSelect").onchange = e=>{ if(e.target.value) openPlan(e.target.value); };
$("#btnExportJson").onclick = ()=>{
  const blob = new Blob([JSON.stringify({current:state, saved:loadStore()},null,1)],{type:"application/json"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download = "shipsplit-backup-"+new Date().toISOString().slice(0,10)+".json"; a.click();
};
$("#btnImportJson").onclick = ()=>$("#jsonFile").click();
$("#jsonFile").onchange = e=>{
  const f = e.target.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = ev=>{
    try{
      const data = JSON.parse(ev.target.result);
      const st = loadStore();
      Object.assign(st, data.saved||{});
      saveStore(st);
      if(data.current){ state = normalizePlan(data.current); }
      render(); markClean(); refreshPlanSelect(); toast("Backup restored");
    }catch(err){ toast("Not a valid backup file"); }
  };
  r.readAsText(f); e.target.value="";
};
// xlsx import
$("#fileDrop").onclick = ()=>$("#xlsxFile").click();
$("#xlsxFile").onchange = e=>{ if(e.target.files[0]) importXlsx(e.target.files[0]); e.target.value=""; };
$("#fileDrop").addEventListener("dragover", e=>{ e.currentTarget.classList.add("dragover"); });
$("#fileDrop").addEventListener("dragleave", e=>e.currentTarget.classList.remove("dragover"));
/* document-level: block the browser's default "navigate away to the dropped file" behavior everywhere
   on the page, and route any dropped file (whether on #fileDrop or anywhere else) through the same
   import path as #fileDrop, so a mis-aimed drop never loses the app. */
document.addEventListener("dragover", e=>{ e.preventDefault(); });
document.addEventListener("drop", e=>{
  if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length){
    e.preventDefault();
    const fd = $("#fileDrop"); if(fd) fd.classList.remove("dragover");
    [...e.dataTransfer.files].forEach(f=>importXlsx(f));
  }
});
/* keep the manual "Add a product" form's unit selectors in step with the display-units toggle, so a
   user reading lb/in everywhere doesn't type pounds into a field silently still set to kg */
function syncAddFormUnits(){
  const k=$("#apKgUnit"), d=$("#apDimUnit");
  if(k) k.value = isImperial()?"lb":"kg";
  if(d) d.value = isImperial()?"in":"cm";
}
// display-unit toggle (kg/cm vs lb/in) -- storage stays metric; this only changes what's rendered
$("#fUnits").addEventListener("change", e=>{ setUnits(e.target.value); syncAddFormUnits(); render(); });
// left-panel product search filter
$("#prodSearch").addEventListener("input", e=>{ productQuery = e.target.value; renderProducts(); });
/* Build a product from raw form values, converting weight/dims to the metric canonical storage.
   Returns null if code or carton count is missing. Shared by the manual add form and the
   per-shipment "New product" modal. */
function buildProduct(code, name, n, qty, kg, kgUnit, dim, dimUnit){
  n = Math.floor(n);
  if(!code || !n || n<1) return null;
  if(kgUnit==="lb") kg = kg/KG2LB;
  if(dimUnit==="in"){ const d = parseDim(dim); if(d) dim = d.map(x=>+(x*IN2CM).toFixed(2)).join("x"); }
  const cartons=[]; for(let i=1;i<=n;i++) cartons.push({n:i, qty:qty||0, dim:dim||"", kg:kg||0, note:""});
  return {id:uid(), code, name:name||code, deadline:"", cartons};
}
// add manual product (left panel)
$("#btnAddProd").onclick = ()=>{
  const prod = buildProduct($("#apCode").value.trim(), $("#apName").value.trim(), +$("#apCartons").value, +$("#apQty").value, +$("#apKg").value, $("#apKgUnit").value, $("#apDim").value.trim(), $("#apDimUnit").value);
  if(!prod){ toast("Need at least a code and case count"); return; }
  state.products.push(prod);
  render();
};
/* Add a brand-new product straight onto a shipment: it lands in the main product list AND is
   fully allocated to that shipment. */
let npCtx = null; // bucket id we're adding a product to
function openAddProductModal(bucketId){
  const b = bucketOf(bucketId); if(!b) return;
  npCtx = bucketId;
  $("#npTitle").textContent = "Add a product to " + (b.label||MODES[b.mode]);
  $("#npSub").textContent = "Creates the product in your main list and assigns all its cases to this shipment.";
  $("#npCode").value=""; $("#npName").value=""; $("#npCartons").value="10"; $("#npQty").value="100";
  $("#npKg").value="6"; $("#npKgUnit").value = isImperial()?"lb":"kg";
  $("#npDim").value=""; $("#npDimUnit").value = isImperial()?"in":"cm";
  $("#npOverlay").classList.add("show");
  setTimeout(()=>{ $("#npCode").focus(); }, 50);
}
$("#npCancel").onclick = ()=>{ $("#npOverlay").classList.remove("show"); npCtx=null; };
$("#npOk").onclick = ()=>{
  const b = bucketOf(npCtx);
  if(!b){ $("#npOverlay").classList.remove("show"); npCtx=null; return; }
  const prod = buildProduct($("#npCode").value.trim(), $("#npName").value.trim(), +$("#npCartons").value, +$("#npQty").value, +$("#npKg").value, $("#npKgUnit").value, $("#npDim").value.trim(), $("#npDimUnit").value);
  if(!prod){ toast("Need at least a code and case count"); return; }
  state.products.push(prod);
  b.allocations[prod.id] = prod.cartons.length; // all cartons go to this shipment
  $("#npOverlay").classList.remove("show"); npCtx=null;
  render();
  toast('Added '+prod.code+' to '+(b.label||MODES[b.mode]));
};
$("#npOverlay").addEventListener("click", e=>{ if(e.target && e.target.id==="npOverlay"){ $("#npOverlay").classList.remove("show"); npCtx=null; } });
$("#npOverlay").addEventListener("keydown", e=>{ if(e.key==="Escape") $("#npCancel").click(); });
// AI-extension prompt modal
$("#promptClose").onclick = ()=>{ $("#promptOverlay").classList.remove("show"); };
$("#promptCopy").onclick = async ()=>{
  const ta = $("#promptText");
  try{ await navigator.clipboard.writeText(ta.value); toast("Prompt copied — paste it into your AI browser extension"); }
  catch(e){ ta.focus(); ta.select(); try{ document.execCommand("copy"); toast("Prompt copied"); }catch(e2){ toast("Press Ctrl/Cmd+C to copy"); } }
};
$("#promptOverlay").addEventListener("click", e=>{ if(e.target && e.target.id==="promptOverlay") $("#promptOverlay").classList.remove("show"); });
$("#promptOverlay").addEventListener("keydown", e=>{ if(e.key==="Escape") $("#promptClose").click(); });
// add bucket
$("#btnAddBucket").onclick = ()=>{
  state.buckets.push({id:uid(), label:"Shipment "+(state.buckets.length+1), mode:"ocean-west", destType:"fba-split", shipTo:"", quote:"", transit:"", allocations:{},
    status:"planned", carrier:"", refs:[], depDate:"", arrDate:""});
  render();
};
// quick-start: create the three standard shipments in one click (shown only on an empty plan)
$("#btnQuickStart").onclick = ()=>{
  [{label:"Air", mode:"air", transit:"8"},
   {label:"Ocean West", mode:"ocean-west", transit:"30"},
   {label:"Ocean East", mode:"ocean-east", transit:"38"}].forEach(d=>{
    state.buckets.push({id:uid(), label:d.label, mode:d.mode, destType:"fba-split", shipTo:"", quote:"", transit:d.transit, allocations:{},
      status:"planned", carrier:"", refs:[], depDate:"", arrDate:""});
  });
  render();
  toast("Created Air, Ocean West and Ocean East shipments");
};
/* distribute a product's cases as evenly as possible across ALL shipments (overwrites this product's current split) */
function splitEvenly(p){
  if(!state.buckets.length){ toast("Add a shipment first."); return; }
  const total = p.cartons.length, n = state.buckets.length;
  const base = Math.floor(total/n); let rem = total % n;
  state.buckets.forEach((b,i)=>{ const v = base + (i<rem?1:0); if(v>0) b.allocations[p.id]=v; else delete b.allocations[p.id]; });
  render();
  toast("Split "+total+" cases of "+p.code+" across "+n+" shipments");
}
$("#btnCollapseAll").onclick = ()=>{
  const ids = state.buckets.map(b=>b.id);
  const anyExpanded = ids.some(id=>!collapsedBuckets.has(id));
  if(anyExpanded) ids.forEach(id=>collapsedBuckets.add(id));   // some open -> minimize everything
  else collapsedBuckets.clear();                                // all minimized -> expand everything
  renderBuckets();
};
$("#btnExportAll").onclick = exportAll;

// cloud sync UI
/* cloudModalView: "detecting" | "setup" | "unlock" | "connected" | "advanced" */
let cloudModalView = "detecting";
function renderCloudModalView(view){
  cloudModalView = view;
  $("#ghDetecting").style.display = view==="detecting" ? "" : "none";
  $("#ghSetupView").style.display = view==="setup" ? "" : "none";
  $("#ghUnlockView").style.display = view==="unlock" ? "" : "none";
  $("#ghConnectedView").style.display = view==="connected" ? "" : "none";
  $("#ghAdvancedView").style.display = view==="advanced" ? "" : "none";
  const rec = $("#ghRecoverView"); if(rec) rec.style.display = view==="recover" ? "" : "none";
  $("#btnGhDisconnect").style.display = view==="connected" ? "" : "none";
  $("#ghStatus").textContent = "";
  // Sign in / Sign up tabs are only meaningful on the two auth forms
  const tabs = $("#ghTabs");
  if(tabs){
    tabs.style.display = (view==="unlock"||view==="setup") ? "" : "none";
    $("#ghTabSignin").classList.toggle("active", view==="unlock");
    $("#ghTabSignup").classList.toggle("active", view==="setup");
  }
  const title = $("#ghModalTitle");
  const toggle = $("#ghAdvancedToggle");
  const primary = $("#btnGhPrimary");
  if(title){ title.textContent = view==="unlock" ? "Sign in" : view==="setup" ? "Sign up" : view==="advanced" ? "Advanced setup" : view==="recover" ? "Can't sign in" : "Cloud sync"; }
  if(view==="recover"){
    toggle.style.display = "none"; primary.style.display = "none";
    // tell the user up front whether THIS device can do the one-click reset
    const hint = $("#ghResetHint"), btn = $("#btnGhResetHere");
    const has = !!loadGhConfig().token;
    if(hint) hint.textContent = has ? "this device can" : "this device has no token stored";
    if(btn) btn.disabled = !has;
  } else if(view==="detecting"){
    toggle.style.display = "none"; primary.style.display = "none";
  } else if(view==="setup"){
    toggle.style.display = ""; toggle.textContent = "Advanced: paste token directly";
    primary.style.display = ""; primary.textContent = "Sign up";
  } else if(view==="unlock"){
    /* sign in never mentions a token; the token path lives on the Sign up tab / Advanced */
    toggle.style.display = "none";
    primary.style.display = ""; primary.textContent = "Sign in";
  } else if(view==="connected"){
    toggle.style.display = "none"; primary.style.display = "none";
  } else if(view==="advanced"){
    toggle.style.display = ""; toggle.textContent = "Back";
    primary.style.display = ""; primary.textContent = "Connect and test";
  }
}
async function openCloudModal(){
  $("#cloudOverlay").classList.add("show");
  const cfg = loadGhConfig();
  if(cfg.token && cloudState!=="error"){
    renderCloudModalView("connected");
    $("#ghStatus").textContent = "Connected.";
    return;
  }
  if(cfg.token && cloudState==="error"){
    renderCloudModalView("advanced");
    $("#ghOwner").value = cfg.owner||"";
    $("#ghRepo").value = cfg.repo||"";
    $("#ghToken").value = cfg.token||"";
    $("#ghStatus").textContent = "Error: token was rejected. Re-enter and connect again.";
    return;
  }
  renderCloudModalView("detecting");
  const blob = await fetchSyncConfigBlob();
  // the modal may have been closed (or re-opened into another state) while we awaited; only act if still detecting
  if(cloudModalView!=="detecting") return;
  const savedId = loadGhConfig().ident || "";
  if(blobHasSetup(blob)){
    // an account already exists -> default to Sign in, but both tabs stay visible so Sign up is one click away
    renderCloudModalView("unlock");
    $("#ghUnlockId").value = savedId; $("#ghUnlockPass").value = "";
    setTimeout(()=>{ const el = savedId ? $("#ghUnlockPass") : $("#ghUnlockId"); if(el) el.focus(); }, 30);
  } else {
    renderCloudModalView("setup");
    $("#ghSetupId").value = savedId; $("#ghSetupToken").value = ""; $("#ghSetupPass1").value = ""; $("#ghSetupPass2").value = "";
    setTimeout(()=>{ const el = $("#ghSetupId"); if(el) el.focus(); }, 30);
  }
}
$("#btnCloud").onclick = openCloudModal;
$("#btnGhClose").onclick = ()=>{ $("#cloudOverlay").classList.remove("show"); };
/* Sync on a device that isn't signed in yet has nothing to pull -> open the sign in / sign up modal instead */
$("#btnSync").onclick = ()=>{ if(!loadGhConfig().token){ openCloudModal(); return; } pullAndMerge(); };

// Sign in / Sign up tabs -- carry the typed identifier across so switching never loses it
$("#ghTabSignin").onclick = ()=>{
  const id = $("#ghUnlockId").value || $("#ghSetupId").value || loadGhConfig().ident || "";
  renderCloudModalView("unlock");
  $("#ghUnlockId").value = id; $("#ghUnlockPass").value = "";
  setTimeout(()=>{ const el = id ? $("#ghUnlockPass") : $("#ghUnlockId"); if(el) el.focus(); }, 20);
};
$("#ghTabSignup").onclick = ()=>{
  const id = $("#ghSetupId").value || $("#ghUnlockId").value || loadGhConfig().ident || "";
  renderCloudModalView("setup");
  $("#ghSetupId").value = id;
  setTimeout(()=>{ const el = id ? $("#ghSetupPass1") : $("#ghSetupId"); if(el) el.focus(); }, 20);
};
// Enter submits the visible primary action; Escape or a backdrop click closes the modal
$("#cloudOverlay").addEventListener("keydown", e=>{
  if(e.key==="Enter"){ const p=$("#btnGhPrimary"); if(p && p.style.display!=="none"){ e.preventDefault(); p.click(); } }
  else if(e.key==="Escape"){ $("#btnGhClose").click(); }
});
$("#cloudOverlay").addEventListener("click", e=>{ if(e.target && e.target.id==="cloudOverlay") $("#btnGhClose").click(); });

$("#ghAdvancedToggle").onclick = async (e)=>{
  e.preventDefault();
  if(cloudModalView==="advanced"){ await openCloudModal(); return; }
  const cfg = loadGhConfig();
  renderCloudModalView("advanced");
  $("#ghOwner").value = cfg.owner||"";
  $("#ghRepo").value = cfg.repo||"";
  $("#ghToken").value = cfg.token||"";
};
$("#ghChangeLink").onclick = (e)=>{
  e.preventDefault();
  const cfg = loadGhConfig();
  renderCloudModalView("setup");
  $("#ghSetupId").value = cfg.ident||"";
  $("#ghSetupToken").value = cfg.token||"";
  $("#ghSetupPass1").value = ""; $("#ghSetupPass2").value = "";
  $("#ghStatus").textContent = "Prefilled with your current token. Set an email/username + password and press Sign up to re-encrypt.";
};
/* Password reset that needs NO old password: a device that is already signed in still holds the
   token in localStorage, so it can simply re-encrypt it under a new password and overwrite the
   stored login (the account entry is keyed by the identifier, so signing up again replaces it). */
function startPasswordReset(){
  const cfg = loadGhConfig();
  if(!cfg.token){
    renderCloudModalView("recover");
    $("#ghStatus").textContent = "This device has no saved token, so it can't reset the password. Use option 2 or 3.";
    return;
  }
  renderCloudModalView("setup");
  $("#ghSetupId").value = cfg.ident||"";
  $("#ghSetupToken").value = cfg.token;
  $("#ghSetupPass1").value = ""; $("#ghSetupPass2").value = "";
  $("#ghStatus").textContent = "Using the token already on this device — pick a NEW password and press Sign up. The old password stops working.";
  setTimeout(()=>{ const el = cfg.ident ? $("#ghSetupPass1") : $("#ghSetupId"); if(el) el.focus(); }, 30);
}
$("#ghForgotLink").onclick = (e)=>{ e.preventDefault(); renderCloudModalView("recover"); };
$("#btnGhResetPass").onclick = startPasswordReset;
$("#btnGhResetHere").onclick = startPasswordReset;
$("#btnGhToSignup").onclick = ()=>{
  renderCloudModalView("setup");
  const cfg = loadGhConfig();
  $("#ghSetupId").value = cfg.ident||""; $("#ghSetupToken").value = ""; $("#ghSetupPass1").value=""; $("#ghSetupPass2").value="";
  $("#ghStatus").textContent = "Paste the new token, pick an email/username and password, then press Sign up. Your saved plans are not affected.";
};

async function doSetup(){
  const ident = $("#ghSetupId").value.trim();
  const token = $("#ghSetupToken").value.trim();
  const p1 = $("#ghSetupPass1").value;
  const p2 = $("#ghSetupPass2").value;
  if(!ident){ $("#ghStatus").textContent = "Enter an email or username."; return; }
  if(!token){ $("#ghStatus").textContent = "Please paste a token."; return; }
  if(!p1 || p1.length<8){ $("#ghStatus").textContent = "Choose a password (at least 8 characters, longer is safer)."; return; }
  if(p1!==p2){ $("#ghStatus").textContent = "Passwords don't match."; return; }
  const cfg = {owner: GH_DEFAULTS.owner, repo: GH_DEFAULTS.repo, branch: GH_DEFAULTS.branch, token, ident};
  $("#ghStatus").textContent = "Checking token…";
  try{
    await ghGetPlans(cfg); // throws authError on 401/403; 404 (no plans.json yet) is fine
  }catch(err){
    if(err && err.authError){ $("#ghStatus").textContent = "Token rejected. Check its Contents permission on shipsplit-data."; }
    else{ $("#ghStatus").textContent = "Could not reach GitHub: "+cloudErrorMessage(err); }
    return;
  }
  $("#ghStatus").textContent = "Encrypting and saving your login…";
  try{
    const key = await sha256hex(normId(ident));
    const enc = await encryptToken(token, p1);
    const existing = await fetchSyncConfigBlob(true);
    const accounts = Object.assign({}, blobAccounts(existing));
    delete accounts.__legacy__; // superseded by a real, identified account
    accounts[key] = {salt:enc.salt, iv:enc.iv, ct:enc.ct};
    await pushSyncConfigBlob(token, {v:2, accounts});
    // verify the login is actually retrievable now, so a successful Sign up guarantees Sign in works elsewhere
    const check = await fetchSyncConfigBlob(true);
    if(!blobAccounts(check)[key]){ throw new Error("the setup file did not save correctly. Try again."); }
  }catch(err){
    if(err && err.authError){ $("#ghStatus").textContent = "Token rejected on the shipsplit (app) repo. It needs Contents read/write there too — that write access is what lets you sign in with a password on other devices."; return; }
    $("#ghStatus").textContent = "Could not save your login: "+cloudErrorMessage(err);
    return;
  }
  saveGhConfig(cfg);
  setCloudState("on");
  $("#ghStatus").textContent = "Signed up. Merging plans…";
  await pullAndMerge({quiet:true});
  renderCloudModalView("connected");
  $("#ghStatus").textContent = "Connected. Sign in on any other device with your email/username + password.";
  toast("Cloud sync set up");
}
async function doUnlock(){
  const ident = $("#ghUnlockId").value.trim();
  const pass = $("#ghUnlockPass").value;
  if(!ident){ $("#ghStatus").textContent = "Enter your email or username."; return; }
  if(!pass){ $("#ghStatus").textContent = "Enter your password."; return; }
  $("#ghStatus").textContent = "Signing in…";
  let blob;
  try{ blob = await fetchSyncConfigBlob(true); }catch(e){ blob = null; }
  if(!blob || !blobHasSetup(blob)){ $("#ghStatus").textContent = "No sync setup found yet. Use Sign up on a device that has your token."; return; }
  const accounts = blobAccounts(blob);
  const key = await sha256hex(normId(ident));
  let token = null;
  const exact = accounts[key];
  if(exact){
    try{ token = await decryptToken(exact, pass); }
    catch(e){ $("#ghStatus").textContent = "Wrong password for that email/username."; return; }
  } else {
    // forgiving fallback: if exactly one login is stored, the identifier is effectively cosmetic -> try it
    const keys = Object.keys(accounts);
    if(keys.length===1){ try{ token = await decryptToken(accounts[keys[0]], pass); }catch(e){ token = null; } }
    if(!token){ $("#ghStatus").textContent = "No saved login for that email/username. Check it, or use Sign up."; return; }
  }
  const cfg = {owner: GH_DEFAULTS.owner, repo: GH_DEFAULTS.repo, branch: GH_DEFAULTS.branch, token, ident};
  saveGhConfig(cfg);
  setCloudState("on");
  $("#ghStatus").textContent = "Signed in. Syncing…";
  await pullAndMerge({quiet:true});
  renderCloudModalView("connected");
  $("#ghStatus").textContent = "Connected.";
  toast("Signed in — cloud sync on");
}
async function doAdvancedConnect(){
  const owner = $("#ghOwner").value.trim() || GH_DEFAULTS.owner;
  const repo = $("#ghRepo").value.trim() || GH_DEFAULTS.repo;
  const token = $("#ghToken").value.trim();
  if(!token){ $("#ghStatus").textContent = "Please paste a token."; return; }
  const cfg = {owner, repo, branch: GH_DEFAULTS.branch, token};
  $("#ghStatus").textContent = "Testing connection...";
  try{
    await ghGetPlans(cfg); // throws authError on 401/403; 404 (no file yet) is fine
    saveGhConfig(cfg);
    setCloudState("on");
    $("#ghStatus").textContent = "Connected. Merging plans...";
    await pullAndMerge({quiet:true});
    renderCloudModalView("connected");
    $("#ghStatus").textContent = "Connected.";
  }catch(err){
    if(err && err.authError){
      setCloudState("error");
      $("#ghStatus").textContent = "Token rejected. Check the token's repo/Contents permission.";
      toast("GitHub token rejected. Open Cloud settings.");
    } else {
      $("#ghStatus").textContent = "Could not connect: "+cloudErrorMessage(err);
      toast("Offline, saved locally");
    }
  }
}
$("#btnGhPrimary").onclick = ()=>{
  if(cloudModalView==="setup") doSetup();
  else if(cloudModalView==="unlock") doUnlock();
  else if(cloudModalView==="advanced") doAdvancedConnect();
};
$("#btnGhDisconnect").onclick = ()=>{
  saveGhConfig(Object.assign({}, GH_DEFAULTS));
  cloudSha = null;
  setCloudState("off");
  toast("Cloud disconnected");
  openCloudModal(); // re-detect: remote setup file (if any) is untouched, so offer Unlock/Setup again
};

// delegated events
document.addEventListener("input", e=>{
  const t = e.target;
  if(t.dataset.deadline){ const p=state.products.find(x=>x.id===t.dataset.deadline); if(p){p.deadline=t.value; renderBuckets(); renderSummary();} }
  if(t.dataset.blabel){ bucketOf(t.dataset.blabel).label=t.value; renderSummary(); }
  if(t.dataset.bshipto){ bucketOf(t.dataset.bshipto).shipTo=t.value; renderSummary(); }
  /* quote/transit: update state only while typing. Re-rendering here would rebuild #bucketGrid's
     innerHTML and destroy the very input being typed into (every keystroke after the first was
     lost). Dependent totals refresh on "change" (blur/commit) below. */
  if(t.dataset.bquote){ const bq=bucketOf(t.dataset.bquote); if(bq) bq.quote=t.value; }
  if(t.dataset.invnum){ const b2=bucketOf(t.dataset.invnum); if(b2) invOf(b2).number=t.value; }
  if(t.dataset.invnotes){ const b2=bucketOf(t.dataset.invnotes); if(b2) invOf(b2).notes=t.value; }
  if(t.dataset.invamt){ const b2=bucketOf(t.dataset.invamt); if(b2) invOf(b2).amount=t.value; }
  if(t.dataset.chargeamt){ const [bid,i]=t.dataset.chargeamt.split("|"); const b2=bucketOf(bid); const c=b2&&invOf(b2).charges[+i]; if(c) c.amount=t.value; }
  if(t.dataset.bestcustoms){ const b2=bucketOf(t.dataset.bestcustoms); if(b2) b2.estCustoms=t.value; }
  if(t.dataset.bestduty){ const b2=bucketOf(t.dataset.bestduty); if(b2) b2.estDuty=t.value; }
  if(t.dataset.btransit){ const bt=bucketOf(t.dataset.btransit); if(bt) bt.transit=t.value; }
  /* text fields inside the tracking <details>: just update state on every keystroke, no re-render (would collapse the details / steal focus); a full re-render happens on "change" (blur/commit) below */
  if(t.dataset.bcarrier){ const b=bucketOf(t.dataset.bcarrier); if(b) b.carrier=t.value; }
  if(t.dataset.bdep){ const b=bucketOf(t.dataset.bdep); if(b) b.depDate=t.value; }
  if(t.dataset.barr){ const b=bucketOf(t.dataset.barr); if(b) b.arrDate=t.value; }
  if(t.dataset.refval){
    const [bid,idx] = t.dataset.refval.split("|");
    const b = bucketOf(bid);
    if(b && b.refs && b.refs[+idx]) b.refs[+idx].value = t.value;
  }
  if(t.dataset.alloc){
    const [bid,pid] = t.dataset.alloc.split("|");
    const p = state.products.find(x=>x.id===pid);
    const b = bucketOf(bid);
    let v = Math.max(0, Math.floor(+t.value||0));
    const othersUsed = allocatedCount(p) - (b.allocations[pid]||0);
    if(v > p.cartons.length - othersUsed) v = p.cartons.length - othersUsed;
    b.allocations[pid] = v;
    // debounce full rerender so typing isn't interrupted
    clearTimeout(window._allocT);
    window._allocT = setTimeout(()=>{ render(); }, 700);
  }
  // editable product code/name: update state live; dependent views refresh on commit ("change") below
  if(t.dataset.pcode){ const p=state.products.find(x=>x.id===t.dataset.pcode); if(p) p.code=t.value; }
  if(t.dataset.pname){ const p=state.products.find(x=>x.id===t.dataset.pname); if(p) p.name=t.value; }
  if(t.dataset.pmsku){ const p=state.products.find(x=>x.id===t.dataset.pmsku); if(p) p.msku=t.value; }
  updateSaveIndicator();
});
document.addEventListener("change", e=>{
  const t = e.target;
  if(t.dataset.bmode){ bucketOf(t.dataset.bmode).mode=t.value; render(); }
  if(t.dataset.bdest){ bucketOf(t.dataset.bdest).destType=t.value; renderBuckets(); renderSummary(); } // renderBuckets so the AWD/FBA export buttons re-evaluate
  /* value already applied on input; refresh the derived totals once committed. Deferred a tick so the
     browser finishes moving focus to whatever the user tabbed/clicked into BEFORE we replace the
     grid's innerHTML — otherwise that next field is destroyed under them mid-typing. */
  if(t.dataset.bquote){ const bq=bucketOf(t.dataset.bquote); if(bq) bq.quote=t.value; setTimeout(refreshTotalsSafely,0); }
  if(t.dataset.invamt){ const b2=bucketOf(t.dataset.invamt); if(b2) invOf(b2).amount=t.value; setTimeout(refreshTotalsSafely,0); }
  if(t.dataset.chargeamt){ const [bid,i]=t.dataset.chargeamt.split("|"); const b2=bucketOf(bid); const c=b2&&invOf(b2).charges[+i]; if(c) c.amount=t.value; setTimeout(refreshTotalsSafely,0); }
  if(t.dataset.chargecode){ const [bid,i]=t.dataset.chargecode.split("|"); const b2=bucketOf(bid); const c=b2&&invOf(b2).charges[+i]; if(c){ c.code=t.value; openInvoices.add(bid); renderBuckets(); renderSummary(); } }
  if(t.dataset.bestcustoms || t.dataset.bestduty){ setTimeout(refreshTotalsSafely,0); }
  if(t.dataset.invstatus){ const b2=bucketOf(t.dataset.invstatus); if(b2){ invOf(b2).status=t.value; openInvoices.add(b2.id); renderBuckets(); renderSummary(); } }
  if(t.dataset.invdate){ const b2=bucketOf(t.dataset.invdate); if(b2) invOf(b2).date=t.value; }
  if(t.dataset.invpaid){ const b2=bucketOf(t.dataset.invpaid); if(b2) invOf(b2).paidDate=t.value; }
  if(t.dataset.invnum || t.dataset.invnotes){ setTimeout(refreshTotalsSafely,0); }
  if(t.dataset.btransit){ const bt=bucketOf(t.dataset.btransit); if(bt) bt.transit=t.value; setTimeout(refreshTotalsSafely,0); }
  if(t.dataset.bstatus){ const b=bucketOf(t.dataset.bstatus); if(b){ b.status=t.value; renderBuckets(); renderSummary(); } }
  if(t.dataset.bcarrier){ /* value already applied on input; nothing else depends on it visually */ }
  if(t.dataset.bdep){ const b=bucketOf(t.dataset.bdep); if(b){ b.depDate=t.value; renderBuckets(); renderSummary(); } }
  if(t.dataset.barr){ const b=bucketOf(t.dataset.barr); if(b){ b.arrDate=t.value; renderBuckets(); renderSummary(); } }
  if(t.dataset.reftype){
    const [bid,idx] = t.dataset.reftype.split("|");
    const b = bucketOf(bid);
    if(b && b.refs && b.refs[+idx]){ b.refs[+idx].type=t.value; renderBuckets(); }
  }
  if(t.dataset.refval){ renderBuckets(); } // value already applied on input; re-render to show/hide the "open" link
  if(t.dataset.pcode){ renderBuckets(); renderSummary(); } // code shows in alloc rows + summary; refresh on commit
  if(t.dataset.pqty){
    const p = state.products.find(x=>x.id===t.dataset.pqty);
    if(p){ const qty=Math.max(0,Math.floor(+t.value||0)); p.cartons.forEach(c=>c.qty=qty); render(); }
  }
  if(t.dataset.pkg){
    const p = state.products.find(x=>x.id===t.dataset.pkg);
    if(p){
      /* the field only holds the DISPLAY-rounded number, so converting it back on an incidental blur
         would nudge the canonical metric value (6kg -> 13.23lb -> 6.0010kg). Only write when the user
         actually changed the shown number. */
      const shown = p.cartons[0] ? String(+(dispKg(p.cartons[0].kg)).toFixed(2)) : "";
      if(String(t.value).trim() !== shown){
        let kg=Math.max(0,+t.value||0); if(isImperial()) kg=kg/KG2LB;
        p.cartons.forEach(c=>c.kg=kg); render();
      }
    }
  }
  if(t.dataset.pdim){
    const p = state.products.find(x=>x.id===t.dataset.pdim);
    if(p){
      // three boxes L/W/H share data-pdim; read all three, store the canonical cm value on every case
      const row = t.closest(".pdimrow");
      const inputs = row ? [...row.querySelectorAll("input[data-pdim]")] : [t];
      const nums = inputs.map(inp=>inp.value.trim());
      /* same rounding-drift guard as the weight field: if the three boxes still show exactly what we
         rendered, the user only tabbed through — don't convert the rounded display back into storage */
      const cur = parseDim((p.cartons[0]||{}).dim||"");
      const shown = cur ? (isImperial()? cur.map(x=>String(+(x*CM2IN).toFixed(1))) : cur.map(x=>String(x))) : ["","",""];
      if(nums.length===shown.length && nums.every((v,i)=>v===shown[i])) return;
      let dim = "";
      if(nums.some(v=>v!=="")){
        let vals = nums.map(v=>{ const n=parseFloat(v); return isNaN(n)?0:n; });
        if(isImperial()) vals = vals.map(x=>+(x*IN2CM).toFixed(2)); else vals = vals.map(x=>+x.toFixed(2));
        dim = vals.join("x");
      }
      p.cartons.forEach(c=>c.dim=dim);
      /* Don't re-render the product list here — that would destroy the input mid-tab (L -> W -> H).
         But the card's own case/unit/weight/volume line is derived from the cases we just changed,
         so refresh it in place; otherwise it keeps showing the pre-edit CBM until something else
         happens to redraw, which reads as "my change didn't apply". */
      refreshProductMeta(p);
      renderBuckets(); renderSummary();
    }
  }
  updateSaveIndicator();
});
document.addEventListener("click", e=>{
  const t = e.target;
  if(t.dataset.delprod){
    const pid=t.dataset.delprod, idx=state.products.findIndex(p=>p.id===pid);
    if(idx>=0){
      const removed=state.products[idx];
      const allocs=state.buckets.filter(b=>b.allocations[pid]!=null).map(b=>({b, n:b.allocations[pid]}));
      state.products.splice(idx,1); state.buckets.forEach(b=>delete b.allocations[pid]); render();
      showUndo('Removed '+(removed.code||"product"), ()=>{
        state.products.splice(Math.min(idx,state.products.length),0,removed);
        allocs.forEach(x=>{ x.b.allocations[pid]=x.n; });
        const cut = clampAllocations(removed); // capacity may have been reused while the toast was up
        render();
        if(cut) toast("Restored, but "+cut+" case"+(cut===1?"":"s")+" no longer fit and were dropped");
      });
    }
  }
  if(t.dataset.delbucket){
    const bid=t.dataset.delbucket, idx=state.buckets.findIndex(b=>b.id===bid);
    if(idx>=0){
      const removed=state.buckets[idx];
      state.buckets.splice(idx,1); collapsedBuckets.delete(bid); openTracking.delete(bid); openInvoices.delete(bid); render();
      showUndo('Deleted "'+(removed.label||MODES[removed.mode])+'"', ()=>{ state.buckets.splice(Math.min(idx,state.buckets.length),0,removed); render(); });
    }
  }
  if(t.dataset.rmalloc){
    const [bid,pid]=t.dataset.rmalloc.split("|"); const b=bucketOf(bid);
    if(b){ const prev=b.allocations[pid]; delete b.allocations[pid]; render();
      const p=state.products.find(x=>x.id===pid);
      showUndo('Removed '+((p&&p.code)||"product")+' from '+(b.label||MODES[b.mode]), ()=>{
        /* the freed cases may have been assigned elsewhere while the toast was up — restore only what
           is still available, otherwise the same physical cartons get booked into two shipments */
        const avail = p ? remaining(p) : prev;
        const v = Math.max(0, Math.min(prev, avail));
        if(v>0) b.allocations[pid]=v; else delete b.allocations[pid];
        render();
        if(v<prev) toast(v>0 ? "Restored "+v+" of "+prev+" cases — the rest were reassigned meanwhile"
                            : "Could not restore: those cases are now assigned elsewhere");
      }); }
  }
  if(t.dataset.export){ exportBucket(bucketOf(t.dataset.export)); }
  if(t.dataset.amzsheet){ const [bid,prog]=t.dataset.amzsheet.split("|"); exportAmazonSheet(bucketOf(bid), prog); }
  if(t.dataset.prompt){ openPromptModal(bucketOf(t.dataset.prompt)); }
  if(t.dataset.collapse){ const id=t.dataset.collapse; if(collapsedBuckets.has(id)) collapsedBuckets.delete(id); else collapsedBuckets.add(id); renderBuckets(); }
  if(t.dataset.savebucket){ savePlan(false); }
  if(t.dataset.assign){ const p=state.products.find(x=>x.id===t.dataset.assign); if(p) openCountModal(p, null); }
  if(t.dataset.split){ const p=state.products.find(x=>x.id===t.dataset.split); if(p) splitEvenly(p); }
  if(t.dataset.moveup){ const i=state.buckets.findIndex(b=>b.id===t.dataset.moveup); if(i>0){ const a=state.buckets; [a[i-1],a[i]]=[a[i],a[i-1]]; render(); } }
  if(t.dataset.movedown){ const i=state.buckets.findIndex(b=>b.id===t.dataset.movedown); if(i>=0 && i<state.buckets.length-1){ const a=state.buckets; [a[i+1],a[i]]=[a[i],a[i+1]]; render(); } }
  if(t.dataset.addprodto){ openAddProductModal(t.dataset.addprodto); }
  if(t.dataset.dupbucket){
    const b = bucketOf(t.dataset.dupbucket);
    if(b){
      const copy = {id:uid(), label:(b.label||MODES[b.mode])+" (copy)", mode:b.mode, destType:b.destType, shipTo:b.shipTo, quote:b.quote, transit:b.transit, allocations:{},
        status:"planned", carrier:"", refs:[], depDate:"", arrDate:""};
      const idx = state.buckets.findIndex(x=>x.id===b.id);
      state.buckets.splice(idx+1, 0, copy);
      render();
      toast("Shipment duplicated — settings copied, cases empty");
    }
  }
  if(t.dataset.addref){
    const b = bucketOf(t.dataset.addref);
    if(b){ if(!b.refs) b.refs=[]; b.refs.push({type:"tracking", value:""}); openTracking.add(b.id); renderBuckets(); }
  }
  if(t.dataset.filedrop){
    const inp = document.querySelector('input[data-fileinput="'+t.dataset.filedrop+'"]');
    if(inp) inp.click();
  }
  if(t.dataset.dlfile){
    e.preventDefault();
    if(!cloudOn()){ toast("Set the API address in Cloud settings to open documents."); return; }
    // fetched rather than linked so the session cookie is sent and the response stays a download
    apiFetch("/files/"+encodeURIComponent(t.dataset.dlfile)).then(async res=>{
      if(!res.ok){ toast("Could not download that document."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a2 = document.createElement("a");
      a2.href = url; a2.download = t.textContent || "document";
      document.body.appendChild(a2); a2.click(); a2.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 10000);
    }).catch(()=>toast("Could not reach the server."));
  }
  if(t.dataset.rmfile){
    const [fid,bid] = t.dataset.rmfile.split("|");
    apiFetch("/files/"+encodeURIComponent(fid), {method:"DELETE"}).then(async res=>{
      if(res.ok){ openFiles.add(bid); toast("Document removed"); await loadFiles(); }
      else toast("Could not remove that document.");
    }).catch(()=>toast("Could not reach the server."));
  }
  if(t.dataset.addcharge){
    const b=bucketOf(t.dataset.addcharge);
    if(b){
      const inv=invOf(b);
      // offer the next fee they have not used yet, so repeated clicks don't stack duplicates
      const used=new Set(inv.charges.map(c=>c.code));
      const next=Object.keys(INVOICE_LINES).find(k=>!used.has(k)) || "other";
      inv.charges.push({code:next, amount:"", note:""});
      openInvoices.add(b.id); renderBuckets();
    }
  }
  if(t.dataset.rmcharge){
    const [bid,i]=t.dataset.rmcharge.split("|"); const b=bucketOf(bid);
    if(b){ invOf(b).charges.splice(+i,1); openInvoices.add(bid); renderBuckets(); renderSummary(); }
  }
  if(t.dataset.rmref){
    const [bid,idx] = t.dataset.rmref.split("|");
    const b = bucketOf(bid);
    if(b && b.refs){ b.refs.splice(+idx,1); openTracking.add(bid); renderBuckets(); }
  }
});
/* keep track of which shipments' "Tracking and status" panel is open across re-renders (in-memory only, never saved) */
document.addEventListener("change", e=>{
  const t = e.target;
  if(t && t.dataset && t.dataset.fileinput){
    const bid = t.dataset.fileinput;
    if(t.files && t.files.length) uploadFiles(bid, [...t.files]);
    t.value = "";   // let the same file be picked again after a failure
  }
}, true);
/* Drag and drop straight onto the shipment: the common case is dragging a PDF out of an email. */
document.addEventListener("dragover", e=>{
  const z = e.target.closest && e.target.closest("[data-filedrop]");
  if(z){ e.preventDefault(); z.classList.add("over"); }
});
document.addEventListener("dragleave", e=>{
  const z = e.target.closest && e.target.closest("[data-filedrop]");
  if(z) z.classList.remove("over");
});
document.addEventListener("drop", e=>{
  const z = e.target.closest && e.target.closest("[data-filedrop]");
  if(!z) return;
  e.preventDefault(); z.classList.remove("over");
  const files = e.dataTransfer && e.dataTransfer.files;
  if(files && files.length) uploadFiles(z.dataset.filedrop, [...files]);
});
document.addEventListener("toggle", e=>{
  const el = e.target;
  if(el && el.matches && el.matches("details.tracking")){
    const bid = el.dataset.trackid;
    if(el.open) openTracking.add(bid); else openTracking.delete(bid);
  }
  if(el && el.matches && el.matches("details.invoice")){
    const bid = el.dataset.invid;
    if(el.open) openInvoices.add(bid); else openInvoices.delete(bid);
  }
  if(el && el.matches && el.matches("details.files-panel")){
    const bid = el.dataset.filesid;
    if(el.open) openFiles.add(bid); else openFiles.delete(bid);
  }
}, true);
/* Update one product card's derived numbers without rebuilding it, so a focused input survives. */
function refreshProductMeta(p){
  const card = document.querySelector('.prod[data-pid="'+p.id+'"]');
  if(!card) return;
  const meta = card.querySelector(".meta");
  if(meta){
    const units = p.cartons.reduce((s,c)=>s+(c.qty||0),0);
    const kg    = p.cartons.reduce((s,c)=>s+(c.kg||0),0);
    const cbm   = p.cartons.reduce((s,c)=>s+cbmOf(c.dim),0);
    meta.innerHTML = `<span><b>${p.cartons.length}</b> cases</span><span><b>${fmt(units,0)}</b> units</span>`
      + `<span><b>${fmt(dispKg(kg),0)}</b> ${weightUnitLabel()}</span><span><b>${fmt(dispCbm(cbm),2)}</b> ${volUnitLabel()}</span>`;
  }
  // the "mixed" hint next to the size boxes is only true until an edit makes every case the same
  const dims = p.cartons.map(c=>c.dim).filter(Boolean);
  const uniform = dims.length>0 && dims.every(d=>d===dims[0]);
  const row = card.querySelector(".pdimrow");
  if(row){
    const hint = row.querySelector(".hint");
    if(uniform && hint) hint.remove();
  }
}
function bucketOf(id){ return state.buckets.find(b=>b.id===id); }
function refreshTotalsOnly(){ renderBuckets(); renderSummary(); }
/* Refresh derived numbers without yanking the DOM out from under someone still typing in the grid.
   While focus is inside #bucketGrid we rebuild only the summary table (which holds no field the user
   could be editing); the grid's own footer catches up on the next render once they move on. */
function refreshTotalsSafely(){
  const grid = $("#bucketGrid");
  if(grid && grid.contains(document.activeElement)) renderSummary();
  else refreshTotalsOnly();
}

// drag and drop
document.addEventListener("dragstart", e=>{
  const card = e.target.closest? e.target.closest(".prod") : null;
  if(card){ e.dataTransfer.setData("text/plain", card.dataset.pid); e.dataTransfer.effectAllowed="copy"; }
});
document.addEventListener("dragover", e=>{
  const bEl = e.target.closest? e.target.closest(".bucket") : null;
  if(bEl){ e.preventDefault(); bEl.classList.add("dragover"); }
});
document.addEventListener("dragleave", e=>{
  const bEl = e.target.closest? e.target.closest(".bucket") : null;
  if(bEl) bEl.classList.remove("dragover");
});
document.addEventListener("drop", e=>{
  const bEl = e.target.closest? e.target.closest(".bucket") : null;
  if(!bEl) return;
  e.preventDefault(); bEl.classList.remove("dragover");
  const pid = e.dataTransfer.getData("text/plain");
  const p = state.products.find(x=>x.id===pid);
  const b = bucketOf(bEl.dataset.bucket);
  if(!p||!b) return;
  const left = remaining(p);
  if(left<=0 && !b.allocations[pid]){ toast("All cases of "+p.code+" are already assigned. Lower another shipment's count first."); return; }
  openCountModal(p, b);
});

/* count modal. b may be a bucket (from drag/drop) or null (from a product's "Assign →" button,
   in which case a shipment picker is shown so the user can choose the target). */
let modalCtx = null;
function bucketMaxAvail(p, b){ return remaining(p) + (b.allocations[p.id]||0); }
function openCountModal(p, b){
  if(!b && !state.buckets.length){ toast("Add a shipment first, then assign."); return; }
  modalCtx = {p, b: b||null};
  const picker = $("#mBucketRow"), sel = $("#mBucket");
  if(b){
    picker.style.display = "none";
    $("#mTitle").textContent = p.code + " → " + (b.label||MODES[b.mode]);
  } else {
    picker.style.display = "";
    sel.innerHTML = state.buckets.map(bk=>`<option value="${bk.id}">${esc(bk.label||MODES[bk.mode])}</option>`).join("");
    const target = state.buckets.find(bk=>bucketMaxAvail(p,bk)>0) || state.buckets[0];
    sel.value = target.id;
    $("#mTitle").textContent = "Assign " + p.code;
  }
  syncCountModal();
  $("#overlay").classList.add("show");
  setTimeout(()=>{$("#mCount").focus();$("#mCount").select();},50);
}
/* recompute the available count + hint for whichever bucket is currently targeted */
function syncCountModal(){
  if(!modalCtx) return;
  const p = modalCtx.p;
  const b = modalCtx.b || bucketOf($("#mBucket").value);
  if(!b) return;
  const left = bucketMaxAvail(p, b);
  $("#mCount").value = left;
  $("#mCount").max = left;
  $("#mSub").textContent = p.cartons.length+" cases total, "+left+" available for "+(b.label||MODES[b.mode])+". Units per case: "+(p.cartons[0]?p.cartons[0].qty:"?");
}
$("#mBucket").addEventListener("change", syncCountModal);
// quick chips: fill the count with Half or All available for the targeted shipment
document.querySelectorAll("[data-mchip]").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    if(!modalCtx) return;
    const p = modalCtx.p, b = modalCtx.b || bucketOf($("#mBucket").value);
    if(!b) return;
    const max = bucketMaxAvail(p, b);
    $("#mCount").value = btn.dataset.mchip==="half" ? Math.max(1, Math.ceil(max/2)) : max;
    $("#mCount").focus(); $("#mCount").select();
  });
});
$("#mOk").onclick = ()=>{
  if(!modalCtx) return;
  const p = modalCtx.p;
  const b = modalCtx.b || bucketOf($("#mBucket").value);
  if(!b){ $("#overlay").classList.remove("show"); modalCtx=null; return; }
  const maxA = bucketMaxAvail(p, b);
  let v = Math.max(0, Math.min(maxA, Math.floor(+$("#mCount").value||0)));
  if(v>0) b.allocations[p.id]=v; else delete b.allocations[p.id];
  $("#overlay").classList.remove("show"); modalCtx=null; render();
};
$("#mCancel").onclick = ()=>{ $("#overlay").classList.remove("show"); modalCtx=null; };
$("#overlay").addEventListener("click", e=>{ if(e.target && e.target.id==="overlay"){ $("#overlay").classList.remove("show"); modalCtx=null; } });
$("#mCount").addEventListener("keydown", e=>{ if(e.key==="Enter") $("#mOk").click(); });
// Escape must close the count modal from anywhere inside it, not only from the number field
$("#overlay").addEventListener("keydown", e=>{ if(e.key==="Escape") $("#mCancel").click(); });
/* Keep Tab inside an open modal — without this, tabbing past the last control lands on the header
   toolbar behind the overlay, where Save/Delete are still operable by keyboard. */
document.addEventListener("keydown", e=>{
  if(e.key!=="Tab") return;
  const modal = [...document.querySelectorAll(".overlay.show .modal")].pop();
  if(!modal) return;
  const f = [...modal.querySelectorAll('a[href],button,input,select,textarea')].filter(el=>!el.disabled && el.offsetParent!==null);
  if(!f.length) return;
  const first=f[0], last=f[f.length-1];
  if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
  else if(!modal.contains(document.activeElement)){ e.preventDefault(); first.focus(); }
});

// keyboard shortcut: Cmd/Ctrl+S saves the current plan
document.addEventListener("keydown", e=>{
  if((e.metaKey||e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key==="s"||e.key==="S")){ e.preventDefault(); savePlan(false); }
});

/* autosave current work-in-progress every 20s so a closed tab loses nothing */
setInterval(()=>{ try{ localStorage.setItem("shipsplit_wip", JSON.stringify(state)); }catch(e){} }, 20000);
/* keep the "synced Nm ago" label fresh */
setInterval(updateSyncInfo, 30000);
window.addEventListener("load", ()=>{
  refreshPlanSelect();
  try{
    const wip = localStorage.getItem("shipsplit_wip");
    if(wip){ const s=normalizePlan(JSON.parse(wip)); if(s.products.length||s.buckets.length||s.planName){ state=s; } }
  }catch(e){}
  syncAddFormUnits();
  render();
  markClean(); // baseline for the unsaved-changes indicator: the state we loaded with
  // background cloud sync: never blocks first render, which already happened from localStorage above
  initCloudUI();
});
