const { chromium } = require('playwright');
const path=require('path'), fs=require('fs');
const FILE='file://'+path.resolve('/home/user/shipsplit/index.html');
(async()=>{
  const res=[],ck=(n,c)=>res.push((c?'PASS':'FAIL')+'  '+n);
  const browser=await chromium.launch(); const page=await (await browser.newContext()).newPage();
  await page.goto(FILE); await page.waitForFunction(()=>typeof window.normalizePlan==='function');
  const real=JSON.parse(fs.readFileSync('/workspace/shipsplit-data/plans.json','utf8'));
  const plan=Object.entries(real).filter(([k])=>k!=="__deleted__")[0][1];

  const r=await page.evaluate((plan)=>{
    const out={};
    state=normalizePlan(JSON.parse(JSON.stringify(plan)));
    out.hasInv=state.buckets.every(b=>b.invoice&&typeof b.invoice==='object');
    out.intact=state.buckets.length===4&&state.products.length===12;
    const b0=state.buckets[0];
    out.q0=Number(b0.quote);
    out.noVar=invoiceVariance(b0)===null;
    out.noAct=invoiceActual(b0)===null;

    b0.invoice.amount="1350";
    let v=invoiceVariance(b0);
    out.over={quote:v.quote,actual:v.actual,delta:v.delta,pct:v.pct,cls:varianceClass(v.pct)};

    b0.invoice.amount="900"; v=invoiceVariance(b0);
    out.under={delta:v.delta,cls:varianceClass(v.pct),txt:varianceText(v)};

    b0.invoice.amount=""; b0.invoice.lines={freight:"800",fuel:"90",customs:"120",duty:"45",storage:"33"};
    out.lineTotal=invoiceLineTotal(b0);
    out.actFromLines=invoiceActual(b0);
    out.evenCls=varianceClass(invoiceVariance(b0).pct);

    b0.invoice.amount="1200";
    out.allInWins=invoiceActual(b0);

    state.buckets[1].invoice.amount="2000";
    const pv=planVariance();
    out.pv={n:pv.n,actual:pv.actual,quote:pv.quote,q1:Number(state.buckets[1].quote)};

    const b2=state.buckets[2];
    b2.invoice.amount="0"; out.zeroIgnored=invoiceActual(b2)===null;
    b2.invoice.amount="abc"; out.junkIgnored=invoiceActual(b2)===null;
    b2.invoice.amount=""; b2.invoice.lines={};
    out.noQuoteNoVar=invoiceVariance({id:"x",quote:"",allocations:{},refs:[],invoice:{amount:"500",lines:{}}})===null;

    // render end to end
    render();
    out.panels=document.querySelectorAll('details.invoice').length;
    out.chips=document.querySelectorAll('.varchip').length;
    out.banner=!!document.querySelector('.varbanner');
    out.headers=[...document.querySelectorAll('#summaryBody th')].map(t=>t.textContent);
    out.rowCells=document.querySelectorAll('#summaryBody tbody tr')[0].children.length;
    return out;
  }, plan);

  ck("legacy plan gets a blank invoice on every shipment", r.hasInv);
  ck("legacy plan otherwise unchanged (4 shipments, 12 products)", r.intact);
  ck("no variance before an invoice exists", r.noVar);
  ck("actual is null before an invoice", r.noAct);
  ck("variance from all-in amount (1088 -> 1350)", r.over.quote===1088&&r.over.actual===1350&&r.over.delta===262);
  ck("over-budget pct correct (~24.1%)", Math.abs(r.over.pct-24.08)<0.05);
  ck("over-budget classed red", r.over.cls==="over");
  ck("under-budget delta negative", r.under.delta===-188);
  ck("under-budget classed green", r.under.cls==="under");
  ck("under-budget text shows a minus sign", /^−/.test(r.under.txt));
  ck("charge lines sum correctly", r.lineTotal===1088);
  ck("actual falls back to the line total", r.actFromLines===1088);
  ck("billed matching quote reads as on-estimate", r.evenCls==="even");
  ck("all-in total takes precedence over lines", r.allInWins===1200);
  ck("plan rollup counts only invoiced shipments", r.pv.n===2);
  ck("plan rollup sums billed", r.pv.actual===3200);
  ck("plan rollup sums quoted", r.pv.quote===1088+r.pv.q1);
  ck("a zero invoice is not treated as billed", r.zeroIgnored);
  ck("junk invoice amount is ignored", r.junkIgnored);
  ck("billed with no quote yields no variance", r.noQuoteNoVar);
  ck("an invoice panel renders on every shipment", r.panels===4);
  ck("variance chips render", r.chips>0);
  ck("plan-level variance banner renders", r.banner);
  ck("summary gained Billed + Variance columns", r.headers.includes("Billed")&&r.headers.includes("Variance"));
  ck("summary rows match the header count", r.rowCells===r.headers.length);

  console.log(res.join("\n"));
  const f=res.filter(x=>x.startsWith('FAIL')).length;
  console.log("\n"+(f?f+" FAILED":"ALL "+res.length+" CHECKS PASSED"));
  await browser.close(); process.exit(f?1:0);
})();
