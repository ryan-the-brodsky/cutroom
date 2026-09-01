import { chromium } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";

const PAGE = fs.readFileSync("/Users/ryan-the-brodsky/Documents/programming/game7/platform/web/e2e/fixtures/probe.html");
const server = http.createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(PAGE); });
await new Promise((r) => server.listen(8791, "127.0.0.1", r));

const VARIANTS = [
  ["A none", []],
  ["B WebMCP", ["--enable-features=WebMCP"]],
  ["C WebMCP,WebMCPTesting,DevToolsWebMCPSupport", ["--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport"]],
  ["D +blink-features", ["--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport", "--enable-blink-features=WebMCP,WebMCPTesting"]],
];
const channel = process.argv[2] || "chrome";

for (const [label, args] of VARIANTS) {
  let b;
  try { b = await chromium.launch({ channel: channel === "chromium" ? undefined : channel, args, headless: false }); }
  catch (e) { console.log(`\n### ${label}: LAUNCH FAILED ${e.message.split("\n")[0]}`); continue; }
  const page = await b.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push(m.type() + ": " + m.text()); });
  await page.goto("http://localhost:8791/", { waitUntil: "load" });
  await page.waitForTimeout(700);
  const r = await page.evaluate(async () => {
    const out = {
      secureContext: window.isSecureContext,
      docModelContext: typeof document.modelContext,
      navModelContext: typeof navigator.modelContext,
      navModelContextTesting: typeof navigator.modelContextTesting,
      probe: window.__probe,
    };
    const mc = document.modelContext || navigator.modelContext;
    if (mc) {
      out.mcProto = Object.getOwnPropertyNames(Object.getPrototypeOf(mc));
      try {
        const tools = await mc.getTools();
        out.getToolsOk = true;
        out.toolCount = tools.length;
        out.tool0 = tools[0] ? { name: tools[0].name, title: tools[0].title, desc: tools[0].description,
          inputSchemaType: typeof tools[0].inputSchema, inputSchema: tools[0].inputSchema,
          keys: Object.keys(tools[0]), protoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(tools[0]) || {}),
          annotations: tools[0].annotations && JSON.parse(JSON.stringify(tools[0].annotations)),
          origin: tools[0].origin } : null;
        if (tools[0]) {
          try { out.execString = await mc.executeTool(tools[0], JSON.stringify({ text: "hi-string" })); }
          catch (e) { out.execStringErr = String(e); }
          try { out.execObject = await mc.executeTool(tools[0], { text: "hi-object" }); }
          catch (e) { out.execObjectErr = String(e); }
        }
      } catch (e) { out.getToolsErr = String(e); }
    }
    const t = navigator.modelContextTesting;
    if (t) {
      out.testingProto = Object.getOwnPropertyNames(Object.getPrototypeOf(t));
      out.testingOwn = Object.getOwnPropertyNames(t);
      for (const m of ["listTools", "getTools"]) {
        if (typeof t[m] === "function") { try { const v = await t[m](); out["testing_" + m] = JSON.parse(JSON.stringify(v)); } catch (e) { out["testing_" + m + "_err"] = String(e); } }
      }
      if (typeof t.executeTool === "function") {
        try { out.testing_execute_str = await t.executeTool("probe_echo", JSON.stringify({ text: "via-testing" })); }
        catch (e) { out.testing_execute_str_err = String(e); }
      }
    }
    out.executed = window.__probe.executed;
    return out;
  }).catch((e) => ({ evalError: String(e) }));
  console.log(`\n### ${label}`);
  console.log(JSON.stringify(r, null, 1));
  if (errs.length) console.log("console:", errs.slice(0, 5));
  await b.close();
}
server.close();
