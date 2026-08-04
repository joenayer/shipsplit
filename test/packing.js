/* The packing list leaves the building — it goes to the factory and the forwarder. These checks
   assert that nothing commercial or internal rides along, and that each carton names its PO. */
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
    state=normalizePlan(JSON.parse(JSON.stringify(pl)));
    state.po="091 + 092";
    state.notes="INTERNAL: margin is thin on this PO, do not reorder from Kaili";
    // products span two POs
    state.products.forEach((x,i)=>{ x.po = i%2===0 ? "091" : "092"; });
    const b0=state.buckets[0];
    b0.quote="1088"; b0.estCustoms="120"; b0.estDuty="260";
    b0.invoice={number:"FX-88213",date:"2026-07-30",currency:"USD",amount:"1720",
      charges:[{code:"freight",amount:"980"}],status:"received",paidDate:"",notes:"demurrage",
      billedKg:190,billedCbm:""};
    b0.refs=[
      {type:"po",value:"BN PO 02263878"},
      {type:"tracking",value:"875281408479"},
      {type:"pickup",value:"SGNA2245"},
      {type:"fba",value:"STAR-RHFC4WYW4BX2Q"},      // internal: Amazon shipment id
      {type:"quote",value:"FedEx Quote ID 33219096"},// internal: forwarder quote id
      {type:"invoice",value:"FX-88213"},             // internal: finance
      {type:"customs",value:"ENTRY-99812"},          // internal: customs entry
    ];
    const rows = bucketSheetRows(b0, cartonSlices());
    return { rows, flat: JSON.stringify(rows) };
  }, plan);

  const flat = r.flat;
  // --- nothing commercial ---
  ck("freight quote is NOT in the packing list", !flat.includes("1088"));
  ck("the word 'Quote' is NOT a header in the packing list", !r.rows.some(row=>row.includes("Quote")));
  ck("estimated customs is NOT in the packing list", !flat.includes("120,") && !flat.includes('"120"'));
  ck("invoice total is NOT in the packing list", !flat.includes("1720"));
  ck("invoice number is NOT in the packing list", !flat.includes("FX-88213"));
  ck("internal plan notes are NOT in the packing list", !/margin is thin/i.test(flat));
  ck("internal workflow status is NOT in the packing list", !/In transit|Booked|Planned/.test(flat));

  // --- references: operational only ---
  ck("FBA shipment id is NOT shared", !flat.includes("STAR-RHFC4WYW4BX2Q"));
  ck("forwarder quote id is NOT shared", !flat.includes("33219096"));
  ck("customs entry number is NOT shared", !flat.includes("ENTRY-99812"));
  ck("PO reference IS shared", flat.includes("BN PO 02263878"));
  ck("tracking number IS shared", flat.includes("875281408479"));
  ck("pickup confirmation IS shared", flat.includes("SGNA2245"));

  // --- what the supplier does need ---
  const header = r.rows.find(row=>row[0]==="CARTON #");
  ck("carton table has a PO # column", header && header.includes("PO #"));
  ck("PO column sits next to the carton numbers", header && header.indexOf("PO #")===2);
  const poIdx = header.indexOf("PO #");
  const lines = r.rows.filter(row=>typeof row[0]==="number");
  ck("every carton line carries a PO", lines.length>0 && lines.every(l=>l[poIdx]==="091"||l[poIdx]==="092"));
  ck("both POs appear across the lines",
    lines.some(l=>l[poIdx]==="091") && lines.some(l=>l[poIdx]==="092"));
  ck("carton lines still carry code, name, qty, dims, weight",
    lines.every(l=>l[3] && l[4] && typeof l[5]==="number" && l[6] && typeof l[7]==="number"));
  ck("totals row aligns with the widened table",
    r.rows.some(row=>row[0]==="TOTAL" && typeof row[5]==="number"));
  ck("per-PO subtotals included when a shipment spans several orders",
    r.rows.some(row=>row[0]==="BY PO"));

  // --- a single-PO plan should not grow a redundant BY PO block ---
  const single=await p.evaluate(()=>{
    state.products.forEach(x=>{ x.po="091"; });
    return bucketSheetRows(state.buckets[0], cartonSlices()).some(row=>row[0]==="BY PO");
  });
  ck("no BY PO block when everything is one order", single===false);

  // --- product with no PO falls back to the plan PO ---
  const fb=await p.evaluate(()=>{
    state.products.forEach(x=>{ x.po=""; });
    const rows=bucketSheetRows(state.buckets[0], cartonSlices());
    const h=rows.find(x=>x[0]==="CARTON #"); const i=h.indexOf("PO #");
    return rows.filter(x=>typeof x[0]==="number").every(l=>l[i]==="091 + 092");
  });
  ck("a product with no PO falls back to the plan's PO", fb);

  console.log(res.join("\n"));
  const f=res.filter(x=>x.startsWith('FAIL')).length;
  console.log("\n"+(f?f+" FAILED":"ALL "+res.length+" CHECKS PASSED"));
  await b.close(); process.exit(f?1:0);
})();
