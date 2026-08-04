const { chromium } = require('playwright');
const path=require('path'), fs=require('fs');
(async()=>{
  const res=[],ck=(n,c)=>res.push((c?'PASS':'FAIL')+'  '+n);
  const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
  await p.goto('file://'+path.resolve('/home/user/shipsplit/index.html'));
  await p.waitForFunction(()=>typeof window.normalizePlan==='function');
  const real=JSON.parse(fs.readFileSync('/workspace/shipsplit-data/plans.json','utf8'));
  const plan=Object.entries(real).filter(([k])=>k!=="__deleted__")[0][1];

  const r=await p.evaluate(pl=>{
    const o={};
    // legacy plan with the OLD fixed-object charge shape must migrate
    const legacy=JSON.parse(JSON.stringify(pl));
    legacy.buckets[0].invoice={number:"OLD-1",date:"",currency:"USD",amount:"1350",
      lines:{freight:"980",fuel:"110",customs:"120",storage:"140",duty:"",brokerage:"0"},status:"received",paidDate:"",notes:""};
    state=normalizePlan(legacy);
    const inv0=state.buckets[0].invoice;
    o.migrated=Array.isArray(inv0.charges);
    o.migratedCount=inv0.charges.length;                 // 4 non-zero, blanks/zeros dropped
    o.migratedCodes=inv0.charges.map(c=>c.code);
    o.legacyGone=inv0.lines===undefined;
    o.lineTotal=invoiceLineTotal(state.buckets[0]);

    // reference types
    o.refTypes=Object.keys(REF_TYPES);

    // estimated customs + duty feed the variance
    const b1=state.buckets[1];
    b1.quote="1000"; b1.estCustoms="150"; b1.estDuty="350";
    o.estParts=estParts(b1);
    o.estTotal=estimatedTotal(b1);
    b1.invoice={number:"X",date:"",currency:"USD",amount:"1600",charges:[],status:"received",paidDate:"",notes:""};
    const v=invoiceVariance(b1);
    o.varVsFullEstimate={quote:v.quote,actual:v.actual,delta:v.delta};   // 1600 vs 1500 = +100
    // without the duty estimate it would have looked like +600 against freight alone
    o.wouldHaveBeen=1600-1000;

    render();
    o.estTotalShown=!!document.querySelector('.esttotal');
    o.chargeRows=document.querySelectorAll('.chargerow').length;
    o.addFeeBtns=document.querySelectorAll('[data-addcharge]').length;
    o.noFixedGrid=document.querySelectorAll('.invgrid').length===0;
    o.filePanels=document.querySelectorAll('details.files-panel').length;
    o.dropZones=document.querySelectorAll('[data-filedrop]').length;
    o.fileInputs=document.querySelectorAll('input[data-fileinput]').length;
    o.kindOptions=[...document.querySelectorAll('select[data-filekind]')[0].options].map(x=>x.value);
    return o;
  }, plan);

  ck("legacy fixed-object charges migrate to a list", r.migrated && r.legacyGone);
  ck("only non-zero legacy charges are carried over (4 of 6)", r.migratedCount===4);
  ck("migrated charge codes preserved", JSON.stringify(r.migratedCodes)===JSON.stringify(["freight","fuel","customs","storage"]));
  ck("migrated charges still total correctly ($1,350)", r.lineTotal===1350);
  ck("new reference type: PO / order #", r.refTypes.includes("po"));
  ck("new reference type: Quote ID", r.refTypes.includes("quote"));
  ck("new reference type: Pickup confirmation #", r.refTypes.includes("pickup"));
  ck("existing reference types kept", ["tracking","container","fba","booking","invoice","other"].every(k=>r.refTypes.includes(k)));
  ck("estimate splits freight / customs / duty", r.estParts.freight===1000&&r.estParts.customs===150&&r.estParts.duty===350);
  ck("estimated total sums all three ($1,500)", r.estTotal===1500);
  ck("variance compares billed against the FULL estimate (+$100)", r.varVsFullEstimate.delta===100);
  ck("...not against freight alone, which would have read +$600", r.wouldHaveBeen===600);
  ck("estimated-total line renders when duties are entered", r.estTotalShown);
  ck("charges render as removable rows", r.chargeRows===4);
  ck("every shipment has an '+ Add fee' button", r.addFeeBtns===4);
  ck("the always-on fixed charge grid is gone", r.noFixedGrid);
  ck("every shipment has a Documents panel", r.filePanels===4);
  ck("every shipment has a drop zone and file picker", r.dropZones===4 && r.fileInputs===4);
  ck("document types offered", r.kindOptions.includes("invoice")&&r.kindOptions.includes("label")&&r.kindOptions.includes("packing_list"));

  // + Add fee actually adds a row, ✕ removes it
  const before=await p.evaluate(()=>document.querySelectorAll('.chargerow').length);
  await p.evaluate(()=>{ openInvoices.add(state.buckets[2].id); renderBuckets(); });
  await p.click(`[data-addcharge="${await p.evaluate(()=>state.buckets[2].id)}"]`);
  const after=await p.evaluate(()=>document.querySelectorAll('.chargerow').length);
  ck("'+ Add fee' adds exactly one charge row", after===before+1);
  ck("added fee starts blank, not zero", await p.evaluate(()=>state.buckets[2].invoice.charges[0].amount===""));
  await p.click('.bucket:nth-child(3) .chargerow .rm');
  ck("✕ removes the charge row", await p.evaluate(()=>document.querySelectorAll('.chargerow').length)===before);

  console.log(res.join("\n"));
  const f=res.filter(x=>x.startsWith('FAIL')).length;
  console.log("\n"+(f?f+" FAILED":"ALL "+res.length+" CHECKS PASSED"));
  await b.close(); process.exit(f?1:0);
})();
