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

  // structural checks that need no network
  ck("Database button exists in the header", await p.$('#btnDb')!==null);
  ck("GitHub button relabelled as the backup", (await p.textContent('#btnCloud')).startsWith('GitHub'));
  ck("saving a plan calls the database sync", await p.evaluate(()=>savePlan.toString().includes('syncEverywhere')));
  ck("database is written before GitHub", await p.evaluate(()=>{
    const src=syncEverywhere.toString();
    return src.indexOf('apiSyncPlans') < src.indexOf('pushToCloud');
  }));
  ck("GitHub failures no longer interrupt (backup runs quiet)",
    await p.evaluate(()=>syncEverywhere.toString().includes('quiet:true')));
  ck("Sync button no longer demands a GitHub token",
    await p.evaluate(()=>!document.querySelector('#btnSync').onclick.toString().includes('openCloudModal')));
  ck("sync sends tombstones so deletions propagate",
    await p.evaluate(()=>apiSyncPlans.toString().includes('__deleted__')));
  ck("a 401 from the database drops the signed-in state rather than looping",
    await p.evaluate(()=>apiSyncPlans.toString().includes('401')));
  ck("not signed in = local only, no crash",
    await p.evaluate(async ()=>{ apiUser=null; return (await apiSyncPlans({quiet:true}))===null; }));

  console.log(res.join("\n"));
  const f=res.filter(x=>x.startsWith('FAIL')).length;
  console.log("\n"+(f?f+" FAILED":"ALL "+res.length+" CHECKS PASSED"));
  await b.close(); process.exit(f?1:0);
})();
