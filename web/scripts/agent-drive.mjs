#!/usr/bin/env node
/**
 * agent-drive — drive a Cutroom page through its NATIVE WebMCP tools from real Chrome.
 *
 *   node scripts/agent-drive.mjs --url https://host/ [--token T] [--profile DIR] [--headed]
 *        [--steps steps.json] [--call tool '{"json":"args"}'] [--list] [--out DIR]
 *
 * steps.json = [{ "tool": "find_shots", "args": { "query": "…" }, "note": "…" }, …]
 * Every step: executeTool via document.modelContext (Chrome passes a JSON string),
 * result printed as JSON, screenshot saved to --out. Exit code 1 if any step returns ok:false
 * unless the step has "allowFail": true.
 *
 * Requires Chrome 150+ (system Chrome is used) and a secure-context URL (https or localhost).
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

// The studio lives at /app; `/` is the public landing page. A bare host gets /app so
// the tools have a page to drive, but an explicit --url is used exactly as given.
const rawUrl = opt("--url", "http://localhost:8770/app");
const url = /^https?:\/\/[^/]+\/?$/.test(rawUrl)
  ? `${rawUrl.replace(/\/$/, "")}/app`
  : rawUrl;
const token = opt("--token", process.env.CUTROOM_TOKEN ?? "");
const profile = resolve(opt("--profile", "/tmp/cutroom-agent-drive-profile"));
const out = resolve(opt("--out", "/tmp/cutroom-agent-drive"));
const stepsFile = opt("--steps");
const callTool = opt("--call");
const callArgs = callTool ? JSON.parse(argv[argv.indexOf("--call") + 2] ?? "{}") : null;
const speed = opt("--speed", "watch");
mkdirSync(out, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: !has("--headed"),
  args: ["--enable-features=WebMCP", "--no-first-run", "--no-default-browser-check"],
  viewport: { width: 1440, height: 900 },
  recordVideo: has("--video") ? { dir: out, size: { width: 1440, height: 900 } } : undefined,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("[console.error]", m.text()); });

const u = new URL(url);
if (token) u.searchParams.set("token", token);
u.searchParams.set("agent_debug", "1");
u.searchParams.set("agent_speed", speed);
await page.goto(u.toString(), { waitUntil: "domcontentloaded" });

// Wait for the native API and for our tools to register (poll from Node; Chrome's
// executeTool/getTools are async and waitForFunction does not await promises reliably).
const redact = (u) => u.replace(/token=[^&]+/, "token=***");
let mode = "none";
for (const deadline = Date.now() + 30000; Date.now() < deadline; ) {
  mode = await page.evaluate(async () => {
    const mc = document.modelContext;
    if (mc) { const t = await mc.getTools(); return t.length > 0 ? "native" : "native-empty"; }
    if (window.__cutroomAgent) return "debug";
    return "none";
  }).catch(() => "none");
  if (mode === "native" || mode === "debug") break;
  await page.waitForTimeout(500);
}
console.log(`[drive] mode=${mode} url=${redact(page.url())}`);
if (mode !== "native" && mode !== "debug") {
  const status = await page.evaluate(() => document.title + " | " + document.body?.innerText?.slice(0, 200));
  console.error(`no WebMCP surface on this page (${mode}); page says: ${status}`);
  await ctx.close(); process.exit(2);
}

async function list() {
  return page.evaluate(async () => {
    const mc = document.modelContext;
    const tools = mc ? await mc.getTools() : await window.__cutroomAgent.list();
    return tools.map((t) => ({ name: t.name, readOnly: !!t.annotations?.readOnlyHint, description: String(t.description).slice(0, 90) }));
  });
}

async function call(name, args) {
  const t0 = Date.now();
  const raw = await page.evaluate(async ({ name, args }) => {
    const mc = document.modelContext;
    if (mc) {
      const tools = await mc.getTools();
      const tool = tools.find((t) => t.name === name);
      if (!tool) return JSON.stringify({ ok: false, error: `no such tool: ${name}` });
      try { return await mc.executeTool(tool, JSON.stringify(args ?? {})); }
      catch (e) { return JSON.stringify({ ok: false, error: `executeTool threw: ${e?.name}: ${e?.message}` }); }
    }
    return JSON.stringify(await window.__cutroomAgent.call(name, args ?? {}));
  }, { name, args });
  let res; try { res = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { res = { ok: false, error: "unparseable result", raw }; }
  res.__ms = Date.now() - t0;
  return res;
}

let stepNo = 0;
async function step(tool, args, note = "", allowFail = false) {
  stepNo++;
  const tag = `${String(stepNo).padStart(2, "0")}-${tool}`;
  console.log(`\n=== ${tag} ${note ? "· " + note : ""}\n--> ${JSON.stringify(args)}`);
  const res = await call(tool, args);
  console.log(`<-- (${res.__ms} ms) ${JSON.stringify(res).slice(0, 1600)}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(out, `${tag}.png`), fullPage: false });
  writeFileSync(resolve(out, `${tag}.json`), JSON.stringify({ tool, args, note, res, url: redact(page.url()) }, null, 2));
  if (res.ok === false && !allowFail) { failures.push(tag); }
  return res;
}
const failures = [];

if (has("--list")) console.log(JSON.stringify(await list(), null, 1));
if (callTool) await step(callTool, callArgs, "cli");
if (stepsFile) {
  const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
  for (const s of steps) {
    // "$prev.jobs" style references to the previous result
    const args = JSON.parse(JSON.stringify(s.args ?? {}), (k, v) =>
      typeof v === "string" && v.startsWith("$prev.") ? v.slice(6).split(".").reduce((o, p) => o?.[p], globalThis.__prev) : v);
    globalThis.__prev = await step(s.tool, args, s.note, s.allowFail);
    if (s.sleepMs) await page.waitForTimeout(s.sleepMs);
  }
}
console.log(`\n[drive] done · ${stepNo} steps · failures: ${failures.length ? failures.join(", ") : "none"} · artifacts in ${out}`);
await ctx.close();
process.exit(failures.length ? 1 : 0);
