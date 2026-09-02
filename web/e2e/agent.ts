/**
 * E2E agent bridge — the single door the specs use to reach Cutroom's tools.
 *
 * Prefers the NATIVE WebMCP API, falls back to workstream A's debug hook.
 * Order (all evaluated inside page script — see docs/TESTING-WEBMCP.md §1.7):
 *
 *   1. `navigator.modelContextTesting`  — Chromium 151+; cloneable payloads. Absent in Chrome 152.
 *   2. `document.modelContext`          — the real thing. Chrome 152 with --enable-features=WebMCP.
 *   3. `window.__cutroomAgent`          — debug hook, needs ?agent_debug=1. CI / no-flag runs.
 *
 * Probe findings that shape this file (docs/TESTING-WEBMCP.md §1):
 *  - `executeTool` takes a JSON **string** and needs both arguments.
 *  - It resolves with a JSON **string**, which we parse.
 *  - `RegisteredTool` is not structured-cloneable (it holds a `Window`), so getTools()
 *    and executeTool() must happen in the SAME evaluate; we never ferry a tool handle out.
 *  - `inputSchema` comes back as a JSON string; we parse it into an object here so specs
 *    can assert on it normally.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { appPath } from "../src/routes";

export type AgentMode = "testing" | "native" | "debug" | "none";

export interface ToolInfo {
  name: string;
  title?: string;
  description: string;
  /** Parsed — Chrome hands it over as a JSON string. */
  inputSchema: Record<string, unknown> | null;
  annotations?: Record<string, boolean>;
  origin?: string;
}

export type ToolResult = { ok: boolean; [k: string]: unknown };

/** Query string every e2e page load carries: debug hook on, trail unpaced. */
export const AGENT_QS = "agent_debug=1&agent_speed=fast";

/**
 * Build an app URL with the agent query params merged in, preserving existing ones.
 * Paths are relative to the app base, so `appUrl("/p/x")` is `/app/p/x` and specs that
 * were written before the studio moved keep working unchanged.
 */
export function appUrl(path: string): string {
  const [p, q = ""] = path.split("?");
  const params = new URLSearchParams(q);
  params.set("agent_debug", "1");
  params.set("agent_speed", "fast");
  return `${appPath(p)}?${params.toString()}`;
}

/** Build a URL outside the app base — the landing page and old deep links. */
export function siteUrl(path: string): string {
  const [p, q = ""] = path.split("?");
  const params = new URLSearchParams(q);
  params.set("agent_debug", "1");
  params.set("agent_speed", "fast");
  return `${p}?${params.toString()}`;
}

/** Navigate to an app route with the agent params, and wait for the tools to register. */
export async function gotoApp(page: Page, path = "/"): Promise<void> {
  await page.goto(appUrl(path));
  await waitForTools(page);
}

/** Which surface is available on this page right now. */
export async function agentMode(page: Page): Promise<AgentMode> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    if ((navigator as unknown as Record<string, unknown>).modelContextTesting) return "testing";
    if ((document as unknown as Record<string, unknown>).modelContext) return "native";
    if (w.__cutroomAgent) return "debug";
    return "none";
  });
}

/** List the registered tools through whichever surface exists. */
export async function listTools(page: Page): Promise<{ mode: AgentMode; tools: ToolInfo[] }> {
  const raw = await page.evaluate(async () => {
    const parse = (s: unknown) => {
      if (typeof s !== "string") return (s as Record<string, unknown>) ?? null;
      try { return JSON.parse(s); } catch { return null; }
    };
    const shape = (t: Record<string, unknown>) => ({
      name: String(t.name),
      title: t.title as string | undefined,
      description: String(t.description ?? ""),
      inputSchema: parse(t.inputSchema),
      annotations: t.annotations ? JSON.parse(JSON.stringify(t.annotations)) : undefined,
      origin: t.origin as string | undefined,
    });

    const testing = (navigator as unknown as { modelContextTesting?: { listTools(): Promise<unknown[]> } }).modelContextTesting;
    if (testing?.listTools) {
      const tools = await testing.listTools();
      return { mode: "testing", tools: (tools as Record<string, unknown>[]).map(shape) };
    }
    const mc = (document as unknown as { modelContext?: { getTools(): Promise<unknown[]> } }).modelContext;
    if (mc?.getTools) {
      const tools = await mc.getTools();
      return { mode: "native", tools: (tools as Record<string, unknown>[]).map(shape) };
    }
    const dbg = (window as unknown as { __cutroomAgent?: { list(): unknown } }).__cutroomAgent;
    if (dbg?.list) {
      const tools = await dbg.list();
      return { mode: "debug", tools: (tools as Record<string, unknown>[]).map(shape) };
    }
    return { mode: "none", tools: [] };
  });
  return raw as { mode: AgentMode; tools: ToolInfo[] };
}

/**
 * Invoke a tool by name and return its parsed result.
 * Throws a readable error if the surface is missing or the tool is not registered —
 * never swallows, because a spec that silently no-ops is worse than a red one.
 */
export async function callTool(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const out = await page.evaluate(
    async ({ name, argsJson }) => {
      const parseResult = (v: unknown) => {
        if (typeof v !== "string") return v;
        try { return JSON.parse(v); } catch { return { ok: false, error: "unparseable_result", raw: v }; }
      };
      const args = JSON.parse(argsJson);

      const testing = (navigator as unknown as {
        modelContextTesting?: { executeTool(n: string, s: string): Promise<unknown> };
      }).modelContextTesting;
      if (testing?.executeTool) {
        try { return { mode: "testing", result: parseResult(await testing.executeTool(name, argsJson)) }; }
        catch (e) { return { mode: "testing", callError: String(e) }; }
      }

      const mc = (document as unknown as {
        modelContext?: {
          getTools(): Promise<{ name: string }[]>;
          executeTool(t: unknown, s: string): Promise<unknown>;
        };
      }).modelContext;
      if (mc?.getTools) {
        // getTools + executeTool must stay in the same evaluate: a RegisteredTool
        // holds a live Window and cannot cross the CDP boundary.
        const tools = await mc.getTools();
        const tool = tools.find((t) => t.name === name);
        if (!tool) return { mode: "native", callError: `tool "${name}" not registered; have: ${tools.map((t) => t.name).join(", ")}` };
        try { return { mode: "native", result: parseResult(await mc.executeTool(tool, argsJson)) }; }
        catch (e) { return { mode: "native", callError: String(e) }; }
      }

      const dbg = (window as unknown as {
        __cutroomAgent?: { call(n: string, a: unknown): Promise<unknown> };
      }).__cutroomAgent;
      if (dbg?.call) {
        try { return { mode: "debug", result: parseResult(await dbg.call(name, args)) }; }
        catch (e) { return { mode: "debug", callError: String(e) }; }
      }
      return { mode: "none", callError: "no WebMCP surface and no __cutroomAgent debug hook" };
    },
    { name, argsJson: JSON.stringify(args) },
  );

  const o = out as { mode: string; result?: unknown; callError?: string };
  if (o.callError) throw new Error(`callTool(${name}) via ${o.mode}: ${o.callError}`);
  return o.result as ToolResult;
}

/** Wait until at least `min` tools are registered (the bridge registers at app mount). */
export async function waitForTools(page: Page, min = 1, timeout = 20_000): Promise<ToolInfo[]> {
  let last: { mode: AgentMode; tools: ToolInfo[] } = { mode: "none", tools: [] };
  await expect
    .poll(async () => { last = await listTools(page); return last.tools.length; }, { timeout, message: `waiting for >= ${min} registered tools` })
    .toBeGreaterThanOrEqual(min);
  return last.tools;
}

/**
 * The on-screen agent trail (workstream A renders it; see WEBMCP-PLAN §3.3).
 * The trail panel starts collapsed, so the steps are not in the DOM until the
 * topbar chip is clicked — open it first, then read `.agent-step`.
 */
export async function trailSteps(page: Page): Promise<string[]> {
  const chip = page.locator('[data-action="app.agent.chip"]');
  if ((await page.locator(".agent-step").count()) === 0 && (await chip.count()) > 0) {
    await chip.first().click().catch(() => {});
    await page.waitForTimeout(200);
  }
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".agent-step"), (n) => (n.textContent || "").trim()),
  );
}

/** Locator for an anchor (`data-action`), optionally narrowed by data attributes. */
export function anchor(page: Page, action: string, data?: Record<string, string>) {
  const extra = data ? Object.entries(data).map(([k, v]) => `[data-${k}="${v}"]`).join("") : "";
  return page.locator(`[data-action="${action}"]${extra}`);
}

/** Parsed `?tab=…&sub=…` etc. from the current URL. */
export function urlParams(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

/** Take paths currently visible in the takes rail. */
export async function railTakes(page: Page): Promise<string[]> {
  return page.locator('[data-action="shot.take"]').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.path || "").filter(Boolean),
  );
}
