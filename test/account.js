/* Account panel + documents gating, driven against the LIVE deployed API. */
const { chromium } = require('playwright');
const path=require('path');
const API='https://shipsplit.joel-036.workers.dev';
(async()=>{
  const res=[],ck=(n,c)=>res.push((c?'PASS':'FAIL')+'  '+n);
  /* This suite talks to the REAL deployed Worker, so the browser has to egress through the sandbox
     proxy and trust its CA. ignoreHTTPSErrors covers the proxy's MITM certificate. */
  const b=await chromium.launch({
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: ['--ignore-certificate-errors'],
  });
  // the app is served from github.io in production; match that origin so CORS behaves as it will live
  const ctx=await b.newContext({ ignoreHTTPSErrors: true });
  const p=await ctx.newPage();
  await p.route('https://joenayer.github.io/shipsplit/**', async route=>{
    const u=new URL(route.request().url());
    const f=u.pathname.replace('/shipsplit/','')||'index.html';
    try{ await route.fulfill({path:path.resolve(__dirname,'..',f)}); }
    catch(e){ await route.fulfill({status:404,body:'no'}); }
  });
  await p.goto('https://joenayer.github.io/shipsplit/index.html');
  await p.waitForFunction(()=>typeof window.normalizePlan==='function');
  await p.waitForTimeout(1200);

  /* This suite needs real network access to the deployed Worker. Sandboxed CI cannot egress, so skip
     rather than fail — a red result there would be about the sandbox, not the code. */
  const reachable = await p.evaluate(async () => {
    try { const r = await fetch(apiBase()+"/health"); return r.ok; } catch(e){ return false; }
  });
  if(!reachable){
    console.log("SKIP  live API unreachable from this environment (no outbound network)");
    await b.close(); process.exit(0);
  }
  ck("client points at the deployed API by default", await p.evaluate(()=>apiBase())===API);
  ck("starts signed out", await p.evaluate(()=>apiUser)===null);

  const email='test-'+Date.now()+'@example.com';
  const signup=await p.evaluate(async e=>{
    const r=await acctPost("/auth/signup",{email:e,password:"a good long password"});
    return {ok:r.ok,status:r.status,codes:(r.data.recoveryCodes||[]).length,email:r.data.email};
  }, email);
  ck("signup works against the live API", signup.ok && signup.email===email);
  ck("live API returns 8 recovery codes", signup.codes===8);

  await p.evaluate(()=>refreshAccount());
  await p.waitForTimeout(600);
  ck("session cookie works cross-site (github.io -> workers.dev)", await p.evaluate(()=>apiUser)===email);
  ck("Account button shows signed-in state", (await p.textContent('#btnAccount')).includes('✓'));

  // documents round-trip through R2
  const up=await p.evaluate(async ()=>{
    state.planName="Live Test Plan"; state.products=[]; state.buckets=[{id:"b1",label:"S1",mode:"air",destType:"awd",shipTo:"IUSF",quote:"",transit:"",allocations:{},refs:[],invoice:blankInvoice()}];
    let r=await apiFetch("/plans/"+encodeURIComponent(state.planName),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({data:state,updatedAt:Date.now()})});
    if(!r.ok) return {step:"put",status:r.status};
    const body=new Blob(["%PDF-1.4 fake invoice"],{type:"application/pdf"});
    r=await apiFetch("/plans/"+encodeURIComponent(state.planName)+"/files/b1?name=invoice.pdf&kind=invoice",{method:"POST",headers:{"Content-Type":"application/pdf"},body});
    if(!r.ok) return {step:"upload",status:r.status};
    const meta=await r.json();
    const list=await (await apiFetch("/files?plan="+encodeURIComponent(state.planName))).json();
    const dl=await apiFetch("/files/"+meta.id);
    const text=await dl.text();
    const disp=dl.headers.get("content-disposition")||"";
    const del=await apiFetch("/files/"+meta.id,{method:"DELETE"});
    const after=await (await apiFetch("/files?plan="+encodeURIComponent(state.planName))).json();
    return {step:"ok",meta,count:list.files.length,text,disp,delOk:del.ok,afterCount:after.files.length};
  });
  ck("plan saved to the live API", up.step!=="put");
  ck("document uploads to R2", up.step==="ok" && up.meta && up.meta.fileName==="invoice.pdf");
  ck("document appears in the plan's file list", up.count===1);
  ck("download returns the original bytes", (up.text||"").startsWith("%PDF-1.4"));
  ck("download is forced as an attachment", /attachment/.test(up.disp||""));
  ck("delete removes it", up.delOk && up.afterCount===0);

  // projection actually ran server-side on that PUT
  const signout=await p.evaluate(async ()=>{ const r=await acctPost("/auth/logout",{}); await refreshAccount(); return r.ok; });
  ck("sign out works", signout && await p.evaluate(()=>apiUser)===null);
  const after=await p.evaluate(async ()=>(await apiFetch("/files?plan=Live%20Test%20Plan")).status);
  ck("files are unreachable once signed out", after===401);

  console.log(res.join("\n"));
  const f=res.filter(x=>x.startsWith('FAIL')).length;
  console.log("\n"+(f?f+" FAILED":"ALL "+res.length+" CHECKS PASSED"));
  await b.close(); process.exit(f?1:0);
})();
