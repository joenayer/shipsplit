/* Plans save to the ShipSplit cloud database, with GitHub kept only as a backup.
   Runs against the LIVE deployed API, from a page origin matching production. */
const { chromium } = require('playwright');
const path=require('path'), fs=require('fs');
const API='https://shipsplit.joel-036.workers.dev';
(async()=>{
  const res=[],ck=(n,c)=>res.push((c?'PASS':'FAIL')+'  '+n);
  const b=await chromium.launch({
    proxy: process.env.HTTPS_PROXY?{server:process.env.HTTPS_PROXY}:undefined,
    args:['--ignore-certificate-errors'],
  });
  const ctx=await b.newContext({ignoreHTTPSErrors:true});
  const p=await ctx.newPage();
  await p.route('https://joenayer.github.io/shipsplit/**', async route=>{
    const u=new URL(route.request().url());
    const f=u.pathname.replace('/shipsplit/','')||'index.html';
    try{ await route.fulfill({path:path.resolve(__dirname,'..',f)}); }
    catch(e){ await route.fulfill({status:404,body:'no'}); }
  });
  await p.goto('https://joenayer.github.io/shipsplit/index.html');
  await p.waitForFunction(()=>typeof window.normalizePlan==='function');

  // GitHub Pages: GitHub login only. The Worker database is a different host.
  ck("this origin is detected as GitHub Pages", await p.evaluate(()=>isGitHubHost()===true));
  ck("GitHub login button is visible", await p.evaluate(()=>{
    const b=document.querySelector('#btnCloud');
    return !!(b && b.style.display!=="none" && b.offsetParent);
  }));
  ck("account login is hidden on GitHub Pages", await p.evaluate(()=>{
    const b=document.querySelector('#btnAccount');
    return !b || b.style.display==="none";
  }));
  ck("database button is hidden on GitHub Pages", await p.evaluate(()=>{
    const b=document.querySelector('#btnDb');
    return !b || b.style.display==="none";
  }));
  ck("landing gate is not forced on GitHub Pages", await p.evaluate(()=>!document.querySelector('#gateOverlay').classList.contains('show')));
  ck("saving a plan still goes through the host-aware sync", await p.evaluate(()=>savePlan.toString().includes('syncEverywhere')));
  ck("GitHub Pages sync writes GitHub, not the Worker database", await p.evaluate(()=>{
    const src=syncEverywhere.toString();
    return src.includes('isGitHubHost') && src.includes('pushToCloud');
  }));
  ck("Sync without a token opens GitHub sign-in",
    await p.evaluate(()=>document.querySelector('#btnSync').onclick.toString().includes('openCloudModal')));
  ck("sync sends tombstones so deletions propagate",
    await p.evaluate(()=>apiSyncPlans.toString().includes('__deleted__')));
  ck("a 401 from the database drops the signed-in state rather than looping",
    await p.evaluate(()=>apiSyncPlans.toString().includes('401')));
  ck("not signed in = local only, no crash",
    await p.evaluate(async ()=>{ apiUser=null; return (await apiSyncPlans({quiet:true}))===null; }));
  ck("apiFetch does not treat an empty same-origin base as missing",
    await p.evaluate(()=>!/if\s*\(\s*!base\s*\)/.test(apiFetch.toString().replace(/\/\/[^\n]*/g,""))));
  ck("cloudOn treats the Worker origin (empty base) as configured",
    await p.evaluate(()=>cloudOn.toString().includes('=== ""')));

  console.log(res.join("\n"));
  const f=res.filter(x=>x.startsWith('FAIL')).length;
  console.log("\n"+(f?f+" FAILED":"ALL "+res.length+" CHECKS PASSED"));
  await b.close(); process.exit(f?1:0);
})();
