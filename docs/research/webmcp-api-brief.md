# WebMCP technical brief (researched 2026-09-01)

Source-cited reference for the Genga Studio WebMCP build. Everything here was verified against
the spec, Chromium source, Chrome docs, or npm on 2026-09-01 unless marked UNVERIFIED.
Read this before touching `web/src/agent/`.

## 1. Status and governance

- **Spec**: <https://webmachinelearning.github.io/webmcp/> — "Draft Community Group Report,
  26 August 2026", W3C Web Machine Learning CG (not standards-track). Explainer + issues:
  <https://github.com/webmachinelearning/webmcp> (README = imperative explainer,
  `declarative-api-explainer.md`, `implementation-status.md`). Editors: Brandon Walderman
  (Microsoft), Khushal Sagar and Dominic Farolino (Google).
- **Chrome**: dev trial M146; **origin trial Chrome 149–156** (OT id `4163014905550602241`);
  Intent to Experiment plans "Shipping M157" (2026-11-03). Milestones: 149 = 2026-06-02,
  150 = 06-30, 152 = 08-25, 153 = 09-08, 156 = 10-20, 157 = 11-03.
- **Flags** (verified in `chrome/browser/flag-metadata.json`):
  `chrome://flags/#enable-webmcp-testing` ("WebMCP for testing", expires M155) and
  `chrome://flags/#devtools-webmcp-support`. Command line: `--enable-features=WebMCP`
  (native API) and `--enable-features=WebMCPTesting,DevToolsWebMCPSupport` (testing surface
  + DevTools pane). Blink runtime features: `WebMCP`, `WebMCPTesting`,
  `WebMCPFormAssociatedCustomElements`, `WebMCPDeclarativeFileInput`.
  Adopter gotcha: stock Chrome 150 with a valid OT token returned `undefined` until
  `--enable-features=WebMCPTesting` was passed — verify wiring early.
- **Edge**: origin trial in Edge 150 (2026-07-02), trial id
  `0b76fe60-b266-458e-a285-04e375c0c31a`, expires 2026-11-17.
- **Firefox**: standards-position `neutral` (2026-08-05); supports the imperative direction.
  **Safari**: `oppose` (2026-06-03). **ChatGPT Desktop supports WebMCP** (OpenAI, 2026-08-26).
- **2026 API churn (merged spec PRs)**: #132 removed `provideContext()`/`clearContext()`;
  #147 `registerTool()` takes an `AbortSignal`; #156 removed `unregisterTool()`; #177 scoped
  `ModelContext` to `Document`; #179 `toolchange` event + Permissions Policy `tools`;
  **#184 (05-27) moved the getter from `navigator` to `document`**; #223 `getTools()`;
  #226 `executeTool()`; #241 `RegisteredTool.inputSchema` string→object; #248 (08-19)
  in-flight executions survive unregistration (Chrome 153+). Chrome 150 deprecates
  `navigator.modelContext` with a one-time console warning (per polyfill README/adopters;
  UNVERIFIED in primary Chrome docs). Open: #204 `requestUserInput`, #217
  `consequentialHint`, #254 `outputSchema`, #279 `executeTool` input type.

## 2. Verified API surface

### Imperative (spec WebIDL, 2026-08-26 draft)

```webidl
partial interface Document {
  [SecureContext, SameObject] readonly attribute ModelContext modelContext;
};
[Exposed=Window, SecureContext]
interface ModelContext : EventTarget {
  Promise<undefined> registerTool(ModelContextTool tool, optional ModelContextRegisterToolOptions options = {});
  Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
  Promise<DOMString> executeTool(RegisteredTool tool, optional object inputObject = {}, optional ModelContextExecuteToolOptions options = {});
  attribute EventHandler ontoolchange;
};
dictionary ModelContextTool {
  required DOMString name;          // 1–128 chars, [A-Za-z0-9_.-] only
  USVString title;
  required DOMString description;
  object inputSchema;               // JSON Schema
  required ToolExecuteCallback execute;
  ToolAnnotations annotations;
};
dictionary ToolAnnotations { boolean readOnlyHint = false; boolean untrustedContentHint = false; };
callback ToolExecuteCallback = Promise<any> (object inputObject, ToolExecuteCallbackOptions options);
dictionary ToolExecuteCallbackOptions { required AbortSignal signal; };
dictionary ModelContextRegisterToolOptions { sequence<USVString> exposedTo; AbortSignal signal; };
dictionary ModelContextGetToolOptions { sequence<USVString> fromOrigins; };
dictionary ModelContextExecuteToolOptions { AbortSignal signal; };
dictionary RegisteredTool { required DOMString name; USVString title; required DOMString description;
  object inputSchema; ToolAnnotations annotations; required Window window; required USVString origin; };
```

**Chromium divergences** (`third_party/blink/renderer/core/script_tools/*.idl`, main):
`executeTool(RegisteredTool tool, DOMString inputArguments, …)` takes a **JSON string**
(spec says object; #279 open) and returns `Promise<DOMString?>`; `RegisteredTool.inputSchema`
is still a `DOMString`; `ToolAnnotations` has a third member `consequentialHint = false`.
Chrome docs sample: `document.modelContext.executeTool(tool, '{"text": "Buy milk"}')`.
**Normalize in our bridge: accept string or object input.**

Explainer sample (verbatim):

```js
const controller = new AbortController();
await document.modelContext.registerTool({
  name: "add-todo",
  description: "Add a new item to the user's active todo list",
  inputSchema: { type: "object", properties: { text: { type: "string", description: "The text content of the todo item" } }, required: ["text"] },
  async execute({ text }) {
    await addTodoItemToCollection(text);
    return { content: [{ type: "text", text: `Added todo item: "${text}" successfully.` }] };
  }
}, { signal: controller.signal });
// controller.abort() unregisters.
document.modelContext.addEventListener("toolchange", async () => { updateAgentToolRegistry(await document.modelContext.getTools()); });
```

Semantics that shape our design:

- **Return value**: `execute` may return anything JSON-serializable; the spec JSON-stringifies
  it for the caller. Plain strings and MCP-style `{content:[{type:"text",text}]}` both work.
  An unserializable value or a **rejected promise surfaces as an opaque `UnknownError`
  DOMException** — so tools must **resolve with an error payload, never reject**.
- **Registration errors**: `InvalidStateError` (document not fully active, duplicate/malformed
  name), `SecurityError` (agent cluster not origin-keyed — never set `document.domain`),
  `NotAllowedError` (Permissions Policy `tools`, default `self`).
- **No `client` argument.** `execute(input, { signal })` only. `requestUserInteraction` was
  proposed and replaced by `requestUserInput` (#204, unshipped). Human-in-the-loop must be
  built in the page (our plan-preview pattern).
- **Cancellation**: `executeTool`'s `signal` is forwarded to `execute`. Before Chrome 153
  aborting the *registration* signal also cancels in-flight executions (#218 footgun) —
  another reason to register app-level tools once at mount, not per component.
- **Lifecycle**: one `ModelContext` per `Document`; tools live while the document is fully
  active; a full navigation destroys them; **SPA route changes do not clear anything**.
  Google: "Always use `AbortSignal` to unregister tools when pages transition."
- **Secure context required**: `https://`, or `http://localhost` / `http://127.0.0.1`.
  A LAN IP over http is NOT a secure context — `document.modelContext` will be undefined there.
- **Events**: `toolchange` on `document.modelContext`.
- **Testing surface**: `navigator.modelContextTesting` behind `WebMCPTesting` —
  `listTools()` / `executeTool(name, jsonString)` (polyfill shim + Cloudflare docs;
  `getTools()` per testingbot; exact Chromium IDL UNVERIFIED).

### Declarative (Chrome docs + explainer)

```html
<form toolname="supportRequestTool" tooldescription="Submit a request for support." action="/submit">
  <label for="firstName">First Name</label><input type=text name=firstName>
  <select name="select" required toolparamdescription="Determines what team this request is routed to.">
    <option value="Customer happiness team">Return my purchase.</option>
  </select>
  <button type=submit>Submit</button>
</form>
<form toolautosubmit toolname="search_tool" tooldescription="Search the web" action="/search"><input type=text name=query></form>
<script>
document.querySelector("form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.agentInvoked) { e.respondWith(Promise.resolve("Search is done!")); }
});
</script>
```

Attributes: `toolname`, `tooldescription`, `toolautosubmit`, `toolparamdescription`
(on controls or a parent `<fieldset>`). `SubmitEvent.agentInvoked` + `respondWith()`.
Schema synthesis is unspecified ("loose": text→string, select→enum). **ChatGPT Desktop
ignores declarative tools entirely** — Genga Studio uses the imperative API only.

## 3. Client landscape

| Client | How it reaches page tools | Works with Claude Code today? | Notes |
|---|---|---|---|
| ChatGPT Desktop built-in browser | Native `document.modelContext` discovery | No (OpenAI-only) | Since 2026-08-26; imperative only; no iframe tools; GPT-5.6 Sol/Terra; each invocation gets a safety review, consequential actions prompt for confirmation. <https://learn.chatgpt.com/docs/webmcp> |
| Gemini in Chrome | Built-in browser agent | No | Announced I/O 2026-05-19 "will soon support"; not confirmed shipped as of 2026-09-01. |
| **`chrome-devtools-mcp`** (Google, v1.8.0, 2026-08-25) | CDP; `--categoryExperimentalWebmcp=true` exposes `list_webmcp_tools(pageId)` and `execute_webmcp_tool(pageId, toolName, input?)` | **Yes — the best bridge today** | Needs Chrome 150+ with `--enable-features=WebMCP`; `--autoConnect` attaches to the running Chrome (enable `chrome://inspect/#remote-debugging`). `claude mcp add chrome-devtools npx chrome-devtools-mcp@latest -- --categoryExperimentalWebmcp=true` |
| `@mcp-b/webmcp-local-relay` 5.1.0 (2026-08-31) | Page embeds `https://cdn.jsdelivr.net/npm/@mcp-b/webmcp-local-relay@latest/dist/browser/embed.js` → `ws://127.0.0.1:9333` → stdio MCP server | Yes, for sites you control | Listens to `toolchange` + 2s polling; `--invoke-timeout` 65s default; duplicate tool names get tab suffixes. |
| Claude in Chrome extension | Screenshots/DOM/clicks/`javascript_tool` | Not natively (anthropics/claude-code#30645 closed not_planned) | Could call `document.modelContext.getTools()`/`executeTool()` via `javascript_tool` (UNVERIFIED end-to-end). |
| Model Context Tool Inspector (unofficial Google, store id `gbpdfapgefenggkahomfgkhfehlcenpd`) | Content script + `WebMCPTesting` | No (manual / Gemini) | Chrome ≥150.0.7861.0 + "WebMCP for testing" flag; run tools by hand. |
| Chrome DevTools › Application › WebMCP pane (149+) | In-browser | No (manual) | Flags `#devtools-webmcp-support` + `#enable-webmcp-testing`; lists tools, invocation log, schema errors, "Run tool". |

## 4. Polyfills and libraries (npm, 2026-09-01)

- `@mcp-b/webmcp-polyfill` **5.1.0**: installs `document.modelContext` (+ deprecated
  `navigator.modelContext` alias) only in secure contexts and only when no native API exists;
  JSON-Schema validation; `initializeWebMCPPolyfill({ installTestingShim: true })` adds
  `navigator.modelContextTesting` (`listTools()`, `executeTool(name, inputJson)`).
- `@mcp-b/webmcp-types` 5.1.0 (types; infers `execute` args from `inputSchema`).
- `use-webmcp-tool` **0.2.0** (GoogleChromeLabs): `useWebMCP({ name, description,
  inputSchema, annotations, execute, enabled, formatOutput, onError })` → `{ supported,
  registered, error }`; no-op where the API is absent; unregisters on unmount.
- `@mcp-b/react-webmcp` 5.1.0 (`useMcpTool`) — Devpost staff confirmed it satisfies the
  challenge's "uses WebMCP" requirement.
- Samples: <https://github.com/GoogleChromeLabs/webmcp-tools> (15 demos incl.
  react-flightsearch, pizza-maker; a "WebMCP Evals" CLI; a polyfill).
  <https://github.com/GoogleChromeLabs/use-webmcp-tool>.

## 5. Design guidance from the spec authors (Chrome docs)

- **Budgets** (<https://developer.chrome.com/docs/ai/webmcp/secure-tools>): tool description
  ≤500 chars, parameter description ≤150, names ≤30, individual output ≤1.5K chars;
  `readOnlyHint` on non-mutating tools; `untrustedContentHint` when returning user/external
  content.
- **Modern Web Guidance** (GoogleChrome/modern-web-guidance-src `guides/webmcp/webmcp/guide.md`):
  specific verbs (`create-event` not `start-event-creation-process`); positive descriptions;
  "Tools should be atomic, composable, and distinct. Do not force flow control instructions";
  accept raw user input as strings (no agent math); specific types and enums over IDs;
  "Validate strictly in code, loosely in schema"; descriptive errors the agent can recover
  from; **"Ensure the function returns after UI state updates"**; register/unregister tools
  dynamically per page context; do not use `unregisterTool`; keep secrets out of the client;
  design by role-playing multi-step journeys; run evals.
- **Security**: prompt-injection vectors (metadata poisoning, output injection, tool
  implementation exploitation); "the agent is a guest on your platform"; tools are ephemeral
  (exist only while the page is open — the human is present).
- Production shape to imitate: Shopify registers 10 tools on every storefront
  (`search_catalog`, `browse_store`, `get_product`, `show_variant`, `get_cart`, `update_cart`,
  `cancel_cart`, `proceed_to_checkout`, `manage_orders`, `search_shop_policies_and_faqs`).

## 6. Relationship to MCP proper

"Web pages that use WebMCP can be thought of as Model Context Protocol servers that implement
tools in client-side script instead of on the backend." Replacing backend MCP is a non-goal —
run both. The loop is discover → `executeTool` → JSON string → next call; browser agents keep
DOM/screenshot access as a fallback and "can inspect page changes".

## 7. Gotchas that shape the Genga Studio design

1. Feature-detect `document.modelContext ?? navigator.modelContext`; never rely on
   `provideContext`/`unregisterTool`.
2. `executeTool` input may arrive as a JSON string (Chrome) or object (spec) — normalize.
3. `registerTool()` resolves `undefined`; confirm with `getTools()` / `toolchange`.
4. Unregistering during execution aborts it before Chrome 153 — register app-level tools once.
5. HTTPS or localhost only; no `document.domain`; cross-origin iframes need `allow="tools"`.
6. Tool bloat degrades selection above ~100 tools; no grouping primitive; respect budgets.
7. **No progress/streaming API** (#196 open). Bridges time out (local relay 65s). Pattern for
   a minutes-long generation: the tool submits and returns `{job}` immediately; a
   `readOnlyHint` status tool polls; a bounded `wait` tool (≤60s) honours `signal`; render
   progress in the page; keep outputs ≤1.5K chars; resolve error text instead of rejecting.
8. Chrome 152.0.7977.65 is installed on this machine (pre-#248 semantics).
