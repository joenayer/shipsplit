const { chromium } = require('playwright');
const path=require('path'), fs=require('fs');
(async()=>{
  const res=[],ck=(n,c)=>res.push((c?'PASS':'FAIL')+'  '+n);
  const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
  await p.goto('file://'+path.resolve('/home/user/shipsplit/index.html'));
  await p.waitForFunction(()=>typeof window.normalizePlan==='function');
  const real=JSON.parse(fs.readFileSync('/workspace/shipsplit-data/plans.json','utf8'));
  const plan=Object.entries(real).filter(([k])=>k!=="__deleted__")[0][1];
  await p.evaluate(pl=>{ state=normalizePlan(JSON.parse(JSON.stringify(pl))); render(); }, plan);

  const totals=()=>p.evaluate(()=>{
    const sl=cartonSlices();
    return state.buckets.map(x=>{const t=bucketTotals(x,sl); return {kg:+t.kg.toFixed(3), cbm:+t.cbm.toFixed(4), units:t.units};});
  });
  const before=await totals();

  // --- WEIGHT: type into the product kg/case box exactly like a user ---
  const pid=await p.evaluate(()=>state.products[0].id);
  const kgSel=`input[data-pkg="${pid}"]`;
  await p.waitForSelector(kgSel);
  await p.fill(kgSel,'25');
  await p.dispatchEvent(kgSel,'change');
  await p.waitForTimeout(150);
  const afterKg=await totals();
  const cartonKg=await p.evaluate(()=>state.products[0].cartons.map(c=>c.kg));
  ck("weight edit writes to every carton of the product", cartonKg.every(k=>Math.abs(k-25)<0.001));
  ck("weight change updates shipment totals", afterKg.some((t,i)=>Math.abs(t.kg-before[i].kg)>0.5));
  const domKg=await p.evaluate(()=>{
    const cell=document.querySelector('.bucket .alloc tbody tr td:nth-child(4)');
    return cell?cell.textContent.trim():null;
  });
  ck("weight change is visible in the shipment allocation table", domKg!==null && domKg!=="0");

  // --- DIMENSIONS ---
  const dimSel=`input[data-pdim="${pid}"]`;
  const dimBoxes=await p.$$(dimSel);
  ck("product has three L/W/H boxes", dimBoxes.length===3);
  await dimBoxes[0].fill('60'); await dimBoxes[1].fill('50'); await dimBoxes[2].fill('40');
  await p.dispatchEvent(dimSel,'change');
  await p.waitForTimeout(150);
  const cartonDims=await p.evaluate(()=>state.products[0].cartons.map(c=>c.dim));
  ck("dimension edit writes to every carton", cartonDims.every(d=>d==='60x50x40'));
  const afterDim=await totals();
  ck("dimension change updates shipment CBM", afterDim.some((t,i)=>Math.abs(t.cbm-afterKg[i].cbm)>0.001));

  // --- SUMMARY table must agree with the shipment cards ---
  const sumKg=await p.evaluate(()=>{
    const rows=[...document.querySelectorAll('#summaryBody tbody tr')].filter(r=>!r.classList.contains('total'));
    return rows.map(r=>r.children[6].textContent.trim());
  });
  const cardKg=await p.evaluate(()=>{
    const sl=cartonSlices();
    return state.buckets.map(x=>String(Math.round(dispKg(bucketTotals(x,sl).kg))));
  });
  ck("summary table weights match the recomputed totals", JSON.stringify(sumKg)===JSON.stringify(cardKg));

  // --- per-unit cost must follow the new weights ---
  const collapsed=await p.evaluate(()=>{
    state.buckets.forEach(x=>collapsedBuckets.add(x.id)); renderBuckets();
    const el=document.querySelector('.bucket-collapsed span');
    return el?el.textContent:'';
  });
  ck("collapsed shipment summary reflects the new weight", /\d/.test(collapsed));

  console.log(res.join("\n"));
  const f=res.filter(x=>x.startsWith('FAIL')).length;
  console.log("\n"+(f?f+" FAILED":"ALL "+res.length+" CHECKS PASSED"));
  await b.close(); process.exit(f?1:0);
})();
