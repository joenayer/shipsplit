/* Billed weight/volume and the $/weight + $/volume rates in the bottom breakdown. */
const { chromium } = require('playwright');
const path=require('path'), fs=require('fs');
(async()=>{
  const res=[],ck=(n,c)=>res.push((c?'PASS':'FAIL')+'  '+n);
  const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
  await p.goto('file://'+path.resolve(__dirname,'../index.html'));
  await p.waitForFunction(()=>typeof window.normalizePlan==='function');
  const real=JSON.parse(fs.readFileSync('/workspace/shipsplit-data/plans.json','utf8'));
  const plan=Object.entries(real).filter(([k])=>k!=="__deleted__")[0][1];

  const r=await p.evaluate(pl=>{
    const o={};
    state=normalizePlan(JSON.parse(JSON.stringify(pl)));
    const b0=state.buckets[0];
    o.plannedKg=+bucketTotals(b0,cartonSlices()).kg.toFixed(2);
    o.plannedCbm=+bucketTotals(b0,cartonSlices()).cbm.toFixed(4);

    b0.quote="1088";
    b0.invoice={number:"I1",date:"",currency:"USD",amount:"1350",charges:[],status:"received",
                paidDate:"",notes:"",billedKg:"",billedCbm:""};
    o.noWeightVariance = weightVariance(b0, o.plannedKg)===null;

    // carrier reweighed: 190 kg vs 167 planned
    b0.invoice.billedKg=190;
    const wv=weightVariance(b0,o.plannedKg);
    o.wv={planned:+wv.planned.toFixed(1),billed:wv.billed,delta:+wv.delta.toFixed(1),pct:+wv.pct.toFixed(2)};
    o.billedRateMetric=+(1350/190).toFixed(2);

    // unit toggle must NOT reinterpret the stored number
    o.metricShown=+(dispKg(billedKgOf(b0))).toFixed(1);
    setUnits&&setUnits("lb_in");
    o.imperialShown=+(dispKg(billedKgOf(b0))).toFixed(1);
    o.storedUnchanged=billedKgOf(b0)===190;
    setUnits&&setUnits("kg_cm");

    // typing 400 while in lb must store ~181.4 kg, not 400
    o.fromLb=(()=>{ setUnits&&setUnits("lb_in"); const v=kgFromInput(400); setUnits&&setUnits("kg_cm"); return +v.toFixed(1); })();

    render();
    const heads=[...document.querySelectorAll('#summaryBody th')].map(h=>h.textContent);
    o.heads=heads;
    o.rowCells=document.querySelectorAll('#summaryBody tbody tr')[0].children.length;
    o.totalCells=document.querySelector('#summaryBody tbody tr.total').children.length;
    o.byMode=document.querySelector('.bymode') ? document.querySelector('.bymode').textContent : "";
    o.actualLine=document.querySelector('.totline.actualline') ? document.querySelector('.totline.actualline').textContent.replace(/\s+/g,' ').trim() : "";
    return o;
  }, plan);

  ck("no weight variance before a billed weight is entered", r.noWeightVariance);
  ck("billed weight variance computed (167 -> 190 kg)", r.wv.billed===190 && r.wv.delta>20 && r.wv.delta<24);
  ck("weight variance percentage is sane (~13-14%)", r.wv.pct>12 && r.wv.pct<15);
  ck("stored billed weight is metric, unaffected by the unit toggle", r.storedUnchanged);
  ck("same stored value displays as kg then lb", Math.abs(r.imperialShown/r.metricShown-2.2046)<0.01);
  ck("typing 400 in lb stores ~181.4 kg", Math.abs(r.fromLb-181.4)<0.2);
  ck("summary gained a $/weight column", r.heads.some(h=>/^\$\/(kg|lb)$/.test(h)));
  ck("summary gained a $/volume column", r.heads.some(h=>/^\$\/(CBM|ft³|cft)/i.test(h)));
  ck("body rows match the header count", r.rowCells===r.heads.length);
  ck("totals row matches the header count", r.totalCells===r.heads.length);
  ck("by-mode breakdown shows a $/weight rate", /\$\/(kg|lb)/.test(r.byMode));
  ck("by-mode breakdown shows a $/volume rate", /\$\/(CBM|ft³|cft)/i.test(r.byMode));
  ck("by-mode breakdown still shows $/unit", /\$\/unit/.test(r.byMode));
  ck("shipment footer shows a billed rate line once invoiced", /Billed/.test(r.actualLine));
  ck("billed rate uses the billed weight, not the planned one", r.actualLine.includes(String(r.billedRateMetric)));

  // the by-mode line and the table row must agree for the same shipment
  const agree=await p.evaluate(()=>{
    const row=[...document.querySelectorAll('#summaryBody tbody tr')][0];
    const heads=[...document.querySelectorAll('#summaryBody th')].map(h=>h.textContent);
    const kgCol=heads.findIndex(h=>/^\$\/(kg|lb)$/.test(h));
    const rowRate=row.children[kgCol].textContent.trim();
    const modeText=document.querySelector('.bymode span').textContent;
    const m=modeText.match(/([\d.,]+)\s*\$\/(kg|lb)/);
    return {rowRate, modeRate:m?m[1]:null};
  });
  ck("by-mode $/weight agrees with the table row (both on billed weight)", agree.rowRate===agree.modeRate);

  console.log(res.join("\n"));
  const f=res.filter(x=>x.startsWith('FAIL')).length;
  console.log("\n"+(f?f+" FAILED":"ALL "+res.length+" CHECKS PASSED"));
  await b.close(); process.exit(f?1:0);
})();
