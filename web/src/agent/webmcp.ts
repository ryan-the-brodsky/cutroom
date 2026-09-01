/**
 * The WebMCP bridge — projects the action registry onto `document.modelContext`.
 *
 * Registration is APP-LEVEL and happens once under a single AbortController: an agent holding
 * a stale tool list can still act, and before Chrome 153 aborting a registration signal also
 * cancels in-flight executions. Tools take `shot` as an explicit argument and navigate
 * themselves, so nothing depends on which page is open.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.2 and docs/research/webmcp-api-brief.md §2.
 */
import type { ActionContext, ActionDef } from "./contract";
import { all, get, perform } from "./registry";

// ------------------------------------------------------------------ the API, as it really is

interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
  annotations?: Record<string, boolean>;
  execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
}
interface ModelContextLike {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<void>;
  getTools?(): Promise<unknown[]>;
}

declare global {
  interface Document { modelContext?: ModelContextLike }
  interface Navigator { modelContext?: ModelContextLike }
  interface Window {
    __cutroomAgent?: {
      mode: AgentMode;
      list(): { name: string; title: string; where: string }[];
      call(name: string, args?: Record<string, unknown>): Promise<unknown>;
    };
  }
}

export type AgentMode = "native" | "polyfill" | "unavailable";
export interface AgentStatus { mode: AgentMode; tools: number }

const POLYFILL_URL = "https://cdn.jsdelivr.net/npm/@mcp-b/webmcp-polyfill@5.1.0/+esm";

let status: AgentStatus = { mode: "unavailable", tools: 0 };
const listeners = new Set<(s: AgentStatus) => void>();

function setStatus(next: Partial<AgentStatus>) {
  status = { ...status, ...next };
  for (const l of [...listeners]) { try { l(status); } catch { /* ignore */ } }
}

export function agentMode(): AgentMode { return status.mode; }
export function agentStatus(): AgentStatus { return status; }

export function subscribeAgentStatus(l: (s: AgentStatus) => void): () => void {
  listeners.add(l);
  l(status);
  return () => { listeners.delete(l); };
}

const flag = (name: string) => {
  try { return new URLSearchParams(window.location.search).get(name); }
  catch { return null; }
};

function wantPolyfill(): boolean {
  const env = (import.meta as { env?: Record<string, string> }).env;
  return env?.VITE_WEBMCP_POLYFILL === "1" || flag("webmcp") === "polyfill";
}

function debugEnabled(): boolean {
  const env = (import.meta as { env?: Record<string, boolean> }).env;
  return Boolean(env?.DEV) || flag("agent_debug") === "1";
}

function findModelContext(): ModelContextLike | undefined {
  if (typeof document === "undefined") return undefined;
  return document.modelContext ?? (navigator as Navigator).modelContext ?? undefined;
}

/** Chrome hands `execute` a JSON string; the spec says an object. Take either. */
export function normalizeInput(input: unknown): Record<string, unknown> {
  if (input == null) return {};
  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return {};
    try {
      const parsed = JSON.parse(t);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { value: parsed };
    } catch { return { value: input }; }
  }
  if (typeof input === "object") return input as Record<string, unknown>;
  return { value: input };
}

/** The registry entries that should be visible to agents. */
export function agentDefs(): ActionDef<any>[] {
  return all().filter((d) => d.surfaces?.agent !== false);
}

function toTool(def: ActionDef<any>, ctx: ActionContext): ModelContextTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: {
      readOnlyHint: def.annotations?.readOnlyHint ?? false,
      untrustedContentHint: def.annotations?.untrustedContentHint ?? false,
      // Chromium-only extra; harmless on spec-shaped implementations.
      consequentialHint: def.annotations?.consequentialHint ?? false,
    },
    // NEVER reject: a rejection surfaces to the agent as an opaque UnknownError.
    execute: async (input, options) => {
      const signal = options?.signal ?? ctx.signal;
      return perform(def.name, normalizeInput(input), { ...ctx, signal });
    },
  };
}

let installed = false;

/**
 * Install the bridge. Idempotent; returns the mode it settled on.
 * `ctx` is the shared ActionContext built by `context.ts`.
 */
export async function installWebMCP(ctx: ActionContext,
                                    controller = new AbortController()): Promise<AgentMode> {
  if (installed) return status.mode;
  installed = true;

  let mc = findModelContext();
  let mode: AgentMode = mc ? "native" : "unavailable";

  if (!mc && wantPolyfill()) {
    try {
      const mod: any = await import(/* @vite-ignore */ POLYFILL_URL);
      const init = mod.initializeWebMCPPolyfill ?? mod.default?.initializeWebMCPPolyfill ?? mod.default;
      if (typeof init === "function") await init({ installTestingShim: true });
      mc = findModelContext();
      if (mc) mode = "polyfill";
    } catch (e) {
      console.warn("[cutroom/agent] WebMCP polyfill failed to load", e);
    }
  }

  const defs = agentDefs();
  let registered = 0;
  if (mc) {
    for (const def of defs) {
      try {
        await mc.registerTool(toTool(def, ctx), { signal: controller.signal });
        registered++;
      } catch (e) {
        console.warn(`[cutroom/agent] registerTool("${def.name}") failed`, e);
      }
    }
  }

  setStatus({ mode, tools: mc ? registered : defs.length });

  if (debugEnabled()) {
    window.__cutroomAgent = {
      get mode() { return status.mode; },
      list: () => agentDefs().map((d) => ({
        name: d.name,
        title: d.title,
        where: typeof d.where === "function" ? d.where({}).label : d.where.label,
      })),
      call: (name: string, args: Record<string, unknown> = {}) =>
        perform(name, args, ctx),
    } as Window["__cutroomAgent"];
  }

  if (mode === "unavailable") {
    console.info(
      "[cutroom/agent] document.modelContext is absent — WebMCP needs a secure context " +
      "(https:// or localhost) and Chrome with --enable-features=WebMCP. " +
      `${defs.length} tools are still available via the ⌘K palette` +
      (debugEnabled() ? " and window.__cutroomAgent.call(name, args)." : "."),
    );
  }
  return mode;
}

/** Re-register the catalogue after tools are added late (C's tools loading after mount). */
export function refreshToolCount(): void {
  setStatus({ tools: agentDefs().length });
}

/** Test seam. */
export function __resetBridge(): void {
  installed = false;
  setStatus({ mode: "unavailable", tools: 0 });
}

export { get as getAction };
