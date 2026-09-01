import { chromium } from "@playwright/test";
import http from "node:http";
const HTML = `<!doctype html><meta charset=utf-8><title>p2</title><body><script>
window.__ev=[]; window.__reg=async(n,extra)=>{const mc=document.modelContext;
  await mc.registerTool(Object.assign({name:n,title:"T",description:"d",inputSchema:{type:"object",properties:{text:{type:"string"}}},
  async execute(i){ if(i&&i.text==="BOOM") throw new Error("kaboom"); if(i&&i.text==="REJECTPAYLOAD") return {ok:false,error:"nope"}; return {ok:true,got:i,typeofInput:typeof i};}},extra||{}));};
</script></body>`;
const s = http.createServer((_q,r)=>{r.writeHead(200,{"content-type":"text/html"});r.end(HTML)});
await new Promise(r=>s.listen(8792,"127.0.0.1",r));
const channel = process.argv[2];
const b = await chromium.launch({ channel, args:["--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport"], headless:false });
const page = await b.newPage();
await page.goto("http://localhost:8792/");
const out = await page.evaluate(async () => {
  const R = {};
  R.navScan = Object.getOwnPropertyNames(Navigator.prototype).filter(k=>/model|mcp|context|tool/i.test(k));
  R.docScan = Object.getOwnPropertyNames(Document.prototype).filter(k=>/model|mcp|context|tool/i.test(k));
  R.globalScan = Object.getOwnPropertyNames(globalThis).filter(k=>/ModelContext|WebMCP|Mcp/i.test(k));
  const mc = document.modelContext;
  R.toolchangeFired = 0;
  mc.addEventListener("toolchange", () => { R.toolchangeFired++; });
  await window.__reg("t_consequential", { annotations: { readOnlyHint:false, consequentialHint:true, untrustedContentHint:true } });
  await new Promise(r=>setTimeout(r,50));
  const tools = await mc.getTools();
  const t = tools.find(x=>x.name==="t_consequential");
  R.annotationsBack = t && JSON.parse(JSON.stringify(t.annotations));
  R.annotationKeys = t && Object.keys(t.annotations);
  R.toolchangeAfterRegister = R.toolchangeFired;
  // structured clone check: does RegisteredTool survive returning from evaluate?
  try { structuredClone(t); R.cloneable = true; } catch (e) { R.cloneable = false; R.cloneErr = String(e).slice(0,90); }
  // throwing execute
  try { R.throwResult = await mc.executeTool(t, JSON.stringify({text:"BOOM"})); } catch(e){ R.throwErr = String(e); }
  // ok:false payload
  R.errPayload = await mc.executeTool(t, JSON.stringify({text:"REJECTPAYLOAD"}));
  // empty / missing args
  try { R.emptyArgs = await mc.executeTool(t, "{}"); } catch(e){ R.emptyArgsErr = String(e); }
  try { R.noArgs = await mc.executeTool(t); } catch(e){ R.noArgsErr = String(e); }
  // duplicate name
  try { await window.__reg("t_consequential"); R.dupOk = true; } catch(e){ R.dupErr = String(e).slice(0,120); }
  // bad name (uppercase / dash / dot)
  for (const bad of ["Bad_Name","dash-name","dot.name"]) {
    try { await window.__reg(bad); R["name_"+bad] = "accepted"; } catch(e){ R["name_"+bad] = String(e).slice(0,80); }
  }
  R.finalCount = (await mc.getTools()).length;
  R.toolchangeTotal = R.toolchangeFired;
  return R;
});
console.log(JSON.stringify(out,null,1));
// can a RegisteredTool be returned across the CDP boundary?
const cross = await page.evaluate(async () => (await document.modelContext.getTools())[0]).then(v=>["returned", JSON.stringify(v).slice(0,200)]).catch(e=>["FAILED", String(e).split("\n")[0]]);
console.log("crossBoundaryReturn:", cross);
await b.close(); s.close();
