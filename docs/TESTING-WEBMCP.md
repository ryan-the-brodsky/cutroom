# Testing Genga Studio's WebMCP layer

Owner: workstream E. Companion to [`WEBMCP-PLAN.md`](WEBMCP-PLAN.md) §8 and
[`research/webmcp-api-brief.md`](research/webmcp-api-brief.md).

Three layers: **vitest** (registry/resolver/tool units, jsdom), **Playwright** (end-to-end in
real Chrome against the *native* WebMCP API), and a **manual cross-client checklist**.

---

## 1. Native-API probe results — Chrome 152.0.7977.65, macOS arm64 (2026-09-01)

**This section is empirical.** Every line below was measured by
[`web/e2e/probe-native-api.mjs`](../web/e2e/probe-native-api.mjs) and `web/e2e/probe2.mjs`
driving the installed `/Applications/Google Chrome.app` through Playwright 1.62.1
(`channel: "chrome"`) against a static page on `http://localhost:8791`. Re-run with
`cd web && node e2e/probe-native-api.mjs chrome`.

### 1.1 The flag that matters

Two browsers were measured: **system Chrome 152.0.7977.65** (`channel: "chrome"` — the
submission target) and **Playwright 1.62.1's bundled Chromium 151.0.7922.34**. They differ,
and the difference matters.

| Chrome args | `document.modelContext` | `navigator.modelContextTesting` |
|---|---|---|
| *(none)* | **undefined** (both) | undefined (both) |
| `--enable-features=WebMCP` | **object** ✅ (both) | undefined (both) |
| `--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport` | object ✅ (both) | Chrome 152: **undefined** · Chromium 151: **object** |
| `…` + `--enable-blink-features=WebMCP,WebMCPTesting` | object ✅ (both) | same as above (no change) |

> **`--enable-features=WebMCP` alone is necessary and sufficient.** No origin-trial token, no
> `chrome://flags` toggle, no `--enable-blink-features` needed for the JS API. We still pass
> `WebMCPTesting,DevToolsWebMCPSupport` in the harness because they light up the DevTools
> **Application › WebMCP** pane, which is a manual surface, not a JS one.

### 1.2 ⚠️ `navigator.modelContextTesting` DOES NOT EXIST in Chrome 152

Scanning `Navigator.prototype` in **system Chrome 152** for anything matching
`/model|mcp|context|tool/i` returns **`[]`** — even with `--enable-features=WebMCPTesting`
*and* `--enable-blink-features=WebMCPTesting`. The API brief listed this surface as
UNVERIFIED; in 152 it is **verified absent**. The plan's §6.E brief assumed we could drive
tests through `navigator.modelContextTesting.listTools()/executeTool(name, json)`.
**Not on the browser the judges (and the author) will use.**

In **Chromium 151** (Playwright's bundle) the same flags *do* install it:

```
navigator.modelContextTesting  →  { listTools(), executeTool(name, jsonString),
                                    getCrossDocumentScriptToolResult(), ontoolchange }
```

`listTools()` returns plain `{ name, description, inputSchema (JSON string) }` — no `window`
member, so unlike `getTools()` it *is* structured-cloneable. `executeTool("probe_echo",
JSON.stringify({...}))` works and returns the JSON string. So the surface is real, just not
present in the 152 stable build on this machine. Treat it as a bonus path, never the only one.

What exists in **both**:

- `Document.prototype.modelContext` — the entry point we rely on.
- Globals `ModelContext` and `WebMCPEvent`.
- `navigator.modelContext`: **undefined in 152** (the deprecated alias is gone); still present
  in 151, where touching it logs *"navigator.modelContext is deprecated. Please use
  document.modelContext instead."* The `document.modelContext ?? navigator.modelContext`
  feature-detect in the bridge is harmless, but on 152 the fallback never fires.

**Consequence for the harness:** `web/e2e/agent.ts` tries `navigator.modelContextTesting`
first (nicest payload), then `document.modelContext`, then the `window.__cutroomAgent` debug
hook — all from *page script* inside `page.evaluate()`.

### 1.3 `ModelContext` shape as shipped

`Object.getOwnPropertyNames(ModelContext.prototype)` →
`["ontoolchange", "executeTool", "getTools", "registerTool", "constructor"]`.
No `unregisterTool`, no `provideContext` — matches the 2026 spec.

`getTools()` returns plain objects with own keys
`["annotations", "description", "inputSchema", "name", "origin", "title", "window"]`.

- **`inputSchema` is a JSON `string`, not an object** (Chromium divergence, confirmed).
  Tests that assert on schemas must `JSON.parse` it.
- `annotations` round-trips **only `readOnlyHint` and `untrustedContentHint`**.
  **`consequentialHint` is silently dropped** — it is *not* in the returned annotations even
  when set at registration. Harmless to set (workstream C should keep setting it for
  forward-compat and for the spec-shaped clients), but **no test may assert on it** and no
  client behaviour can depend on it in 152.
- `origin` is the page origin; `window` is a live `Window` reference.

### 1.4 `executeTool` — string input is mandatory

```js
const tools = await document.modelContext.getTools();
const t = tools.find(x => x.name === "generate_takes");
const json = await document.modelContext.executeTool(t, JSON.stringify(args)); // → DOMString
```

| Call | Result |
|---|---|
| `executeTool(tool, JSON.stringify(args))` | ✅ resolves with a JSON **string** |
| `executeTool(tool, {…})` (spec shape) | ❌ `UnknownError: Failed to parse input arguments` |
| `executeTool(tool)` (input omitted) | ❌ `TypeError: 2 arguments required, but only 1 present` |
| `executeTool(tool, "{}")` | ✅ `execute` receives `{}` |

Page-side, `execute(input)` receives a **parsed object** (`typeof input === "object"`), so the
bridge's "normalize string or object" logic is correct but the string branch is what fires.

### 1.5 Error semantics (confirms the "never reject" rule)

- `execute` **throwing** → caller gets
  `UnknownError: Tool was executed but the invocation failed. For example, the script function threw an error`
  — opaque, no message, useless to an agent.
- `execute` **resolving `{ok:false, error:"nope"}`** → caller gets `{"ok":false,"error":"nope"}`.

`registry.perform()` catching everything and returning `{ok:false}` is therefore load-bearing,
not defensive style.

### 1.6 Two landmines for workstream A

1. **Duplicate registration throws `InvalidStateError: Duplicate tool name`.** React 18
   `StrictMode` double-invokes effects in dev, and Vite HMR re-runs modules — either will
   throw on the second `registerTool` of the same name. The bridge must guard (module-level
   "already registered" flag, or abort the previous controller before re-registering).
2. **Chrome does not validate tool names.** `Bad_Name`, `dash-name` and `dot.name` were all
   accepted. `TOOL_NAME_RE` in `contract.ts` is *our* discipline; the vitest contract test is
   the only thing enforcing it.

`toolchange` fires once per `registerTool` — reliable.

### 1.7 Playwright serialization gotcha

A `RegisteredTool` is **not `structuredClone`-able** (`DataCloneError: #<Window> could not be
cloned`). Playwright's own serializer *can* return it from `page.evaluate` (rendering `window`
as `"ref: <Window>"`), but you cannot pass one back **into** a later `page.evaluate` as a plain
argument. **Do `getTools()` + `executeTool()` inside a single `page.evaluate`** — which is
exactly the shape of `callTool()` in `web/e2e/agent.ts`.

### 1.8 Playwright's bundled Chromium

`npx playwright install chromium` fetched `chromium-1234` = **Chromium 151.0.7922.34**.
It supports WebMCP fully (§1.1) **and** the testing surface (§1.2), so it is a usable second
CI target — but it is *older* than the system Chrome the judges will run, so the
authoritative e2e project is `channel: "chrome"`. `playwright.config.ts` defines both:
`chrome-native` (default) and an optional `chromium-bundled` project.

### 1.9 Secure-context reminder

`http://localhost` and `http://127.0.0.1` are secure contexts (`isSecureContext === true` in
every probe run). **A LAN URL over http is not**, so `document.modelContext` will be
`undefined` there — which is why the `claude-in-chrome` extension path (which needs a LAN
host) cannot exercise WebMCP. Use localhost, or the hosted HTTPS URL.

---

## 2. Running the tests

### Unit (vitest, jsdom)

```bash
cd web
npm install          # first time
npm test             # vitest run
npm run test:watch
```

`web/vitest.config.ts` picks up `src/**/__tests__/**/*.test.ts(x)` and `src/**/*.test.ts(x)`.
`web/vitest.setup.ts` polyfills `CSS.escape`, which **jsdom 25 does not implement** and
`contract.ts#anchorSelector` calls.

### End-to-end (Playwright, real Chrome, native WebMCP)

```bash
cd web
npm run e2e                       # headless-ish; system Chrome with the WebMCP flags
npm run e2e:headed                # watch it drive
npx playwright test e2e/j1-generate.spec.ts --headed --debug
```

`web/playwright.config.ts` starts `scripts/e2e-server.sh` (a scratch `cutroom` server on **:8785** with
a temp `CUTROOM_DATA`, the film imported, `mock` backend, all lanes on mock) via `webServer`
and points `baseURL` at `http://localhost:8785`. It **never touches `~/.cutroom`.**

Every page is loaded with **`?agent_debug=1&agent_speed=fast`** so the debug hook is exposed
and the trail does not pace itself.

`web/e2e/agent.ts` is the single door to the tools:

- `listTools(page)` → `{ mode: "native" | "debug", tools: [{name, description, inputSchema}] }`
- `callTool(page, name, args)` → the parsed `ToolResult`

It prefers `document.modelContext` and falls back to `window.__cutroomAgent.call(name, args)`
when the native API is absent, so the same specs run in CI without the flags.

---

## 3. Driving the tools from Claude Code (`chrome-devtools-mcp`)

This is the path used for the hand-run evals and for the demo recording.

```bash
# 1. once
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest \
  --categoryExperimentalWebmcp=true --autoConnect

# 2. every session — Chrome with the flags, a throwaway profile, CDP on 9222
scripts/dev-agent-chrome.sh http://localhost:8785/p/next-year
```

Then, in Claude Code, the MCP server exposes `list_webmcp_tools` and `execute_webmcp_tool`
(plus the normal DevTools tools). Run the journeys in [`../evals/journeys.json`](../evals/journeys.json)
and record pass/fail in §5.

`scripts/dev-agent-chrome.sh` passes `--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport`,
`--remote-debugging-port=9222` and `--user-data-dir=$(mktemp -d)` so your daily Chrome profile
is untouched (Chrome ignores feature flags for an already-running profile — a separate
user-data-dir is the only reliable way to get them applied).

---

## 4. Manual cross-client checklist

The author runs these by hand; fill in the date and result columns.

| # | Client | Setup | What to check | Date | Result |
|---|---|---|---|---|---|
| 1 | **Chrome DevTools › Application › WebMCP** | `chrome://flags/#enable-webmcp-testing` **and** `chrome://flags/#devtools-webmcp-support` → Enabled → relaunch. Open `http://localhost:8785/p/next-year`, F12 → Application → WebMCP. | All ≥16 tools listed with descriptions; no schema errors; "Run tool" on `find_shots {"query":"David Ross close-up"}` returns candidates; invocation log records it. | | |
| 2 | **`chrome-devtools-mcp` from Claude Code** | §3 above. | `list_webmcp_tools` returns the catalogue; J1 runs end-to-end from a natural sentence; the page visibly navigates and pulses. | | |
| 3 | **Model Context Tool Inspector** extension | Store id `gbpdfapgefenggkahomfgkhfehlcenpd`; needs Chrome ≥150 + "WebMCP for testing" flag. | Tools appear; run `show_me {"feature":"freeze tail"}` by hand; the page navigates and the ❄ control pulses. | | |
| 4 | **ChatGPT Desktop site tools** | Settings › Browser › Enable site tools. Open the **hosted HTTPS URL** in the in-app browser. | Ask *"Make a few more generative cuts of the David Ross close-up."* → it calls `find_shots` then `generate_takes`; consequential actions prompt for confirmation; 3 new takes appear. | | |
| 5 | **Hosted URL in flagged Chrome** | Same flags, hosted HTTPS URL. | Tools register over HTTPS (not just localhost); J1/J2/J4 run; demo-mode caps hold. | | |

**Known non-client:** the Claude in Chrome extension does not speak WebMCP, and the LAN URL it
needs is not a secure context (§1.9). Not on the checklist.

---

## 5. Suite status (2026-09-01 ~19:15 PT)

**vitest: 253 passing / 8 files.** **Playwright `chrome-native`: 19 passing, 2 failing.**
Verified against the native `document.modelContext` in system Chrome 152 — `agentMode`
reports `native`, not the debug fallback.

Green: tool registration (19 tools, all within the name/description/param budgets,
read-only annotations correct), deep links (`?tab=&sub=` restore and round-trip through
the URL), **J1** (find_shots → generate_takes ×3 → 3 stills on screen, URL on
`B10-S2?tab=generate&sub=still`, trail ≥4 steps), **J1b** (the "shot 37" ambiguity is
surfaced with both B10-S2 and B11-S4, and nothing runs), **J2** (freeze the tail, and
never a still), **J4**'s tool contract (job → `wait_for_jobs` → done → animatic named),
**J6** (keeper then timeline source), **J3/show_me** (navigates to Motion edits and
pulses `shot.motion.freeze`).

### Two open gaps, both outside the harness

1. **`list_features` silently returns a partial catalogue.** Its summary says
   *"19 features"* but only **12** come back: `clip()` halves the array to hold
   `BUDGETS.output` (1.5K). An agent asking *"what can you do here?"* is handed an
   incomplete map with no indication anything was dropped — and discovery is the
   product's whole premise. Fix: a leaner per-feature payload, or an explicit
   `total`/`truncated` field plus a `query` to page through.
   (`e2e/show-me.spec.ts` asserts the honest contract and is red until then.)
2. **The finished animatic is not visible in the Cuts gallery** after `cut_film`
   settles — the tool reports the mp4, but the film page renders no `<video>`.
   Asserted with `expect.soft`, so J4's real contract still passes.

### A related trap for tool authors

`clip()` truncates **long strings, including take paths**, with `…`. A truncated path is
an identifier an agent will hand straight back to `select_take`/`set_keeper`, where it
will not resolve. Specs therefore assert on shape (`is_clip`, `kind`, a `renders/motion/`
prefix) rather than on the tail of a path — and tools should keep identifiers out of
`clip()`'s reach.

---

## 6. Eval runs

Journeys live in [`../evals/journeys.json`](../evals/journeys.json) (the §5 hero journeys, with
the utterance, the expected tool sequence with key args, and the expected visible result).
J1/J2/J4/J6 also run automatically as Playwright specs. Record hand-run results here:

| Date | Journey | Client | Tool sequence actually observed | Pass? | Notes |
|---|---|---|---|---|---|
| | | | | | |
