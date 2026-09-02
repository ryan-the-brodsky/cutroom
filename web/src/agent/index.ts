/**
 * The agent layer, installed once at app mount.
 *
 *   registry  →  document.modelContext tools  (agents)
 *             →  ⌘K palette                   (humans)
 *             →  show_me                      (both)
 *
 * `installAgentLayer(router)` builds the shared ActionContext, pulls in workstream B's
 * resolver and workstream C's tool catalogue if they exist, backfills the two smoke tools,
 * and installs the WebMCP bridge. Every import that may not exist yet is dynamic and
 * try/caught so the build stays green while the other workstreams land.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.
 */
import type { ActionContext, ActionDef, ShotResolver } from "./contract";
import { makeContext, setResolver, type RouterLike } from "./context";
import { classifyBackend } from "./guard";
import { settleJobs } from "./jobs";
import { all, register } from "./registry";
import { registerSmokeTools } from "./smoke";
import { agentMode, installWebMCP, refreshToolCount } from "./webmcp";

export { agentMode, agentStatus, subscribeAgentStatus } from "./webmcp";
export { AgentChip, AgentTrail, pulse, trail, getSpeed, setSpeed } from "./presence";
export { default as Palette } from "./Palette";
export { all, get, perform, register, registerAll, whereOf, auditRegistry } from "./registry";
export { usePageHandles, pageHandles } from "./pageHandles";
export { useQueryState, pick, withQuery, fillRoute } from "./urlState";
export { agentContext, makeContext } from "./context";
export { settleJobs, takesOf } from "./jobs";
export { classifyBackend, requireConfirmation, costSentence } from "./guard";

export interface InstallResult {
  mode: ReturnType<typeof agentMode>;
  tools: string[];
  smoke: string[];
  resolver: "workstream-b" | "fallback";
}

let installing: Promise<InstallResult> | null = null;

const isResolver = (v: unknown): v is ShotResolver =>
  Boolean(v) && typeof (v as ShotResolver).resolve === "function" &&
  typeof (v as ShotResolver).index === "function";

/**
 * Pick whatever shape workstream B settled on for `resolve.ts`.
 * B's is `makeResolver(api)` (default-exported), so factories get the real api function —
 * calling one bare leaves it without a fetcher and every resolve fails with "n is not a
 * function" deep inside the minified bundle. Ask me how I know.
 */
function pickResolver(mod: Record<string, unknown>, api: ActionContext["api"]): ShotResolver | null {
  for (const v of [mod.resolver, mod.shotResolver, mod.default]) {
    if (isResolver(v)) return v as ShotResolver;
  }
  for (const key of ["makeResolver", "createResolver", "default"]) {
    const f = mod[key];
    if (typeof f !== "function") continue;
    for (const args of [[api], []] as unknown[][]) {
      try {
        const r = (f as (...a: unknown[]) => unknown)(...args);
        if (isResolver(r)) return r as ShotResolver;
      } catch { /* try the next arity */ }
    }
  }
  return null;
}

/** Pick whatever shape workstream C settled on for `tools/index.ts`. */
function pickTools(mod: Record<string, unknown>): ActionDef<any>[] {
  // ALL_ACTIONS first: it is the tool catalogue PLUS the palette-only feature registry
  // (workstream I), which is what makes ⌘K and show_me cover the whole application.
  for (const key of ["ALL_ACTIONS", "TOOLS", "ALL_TOOLS", "tools", "catalogue", "catalog", "actions", "default"]) {
    const v = mod[key];
    if (Array.isArray(v) && v.every((d) => d && typeof (d as ActionDef).name === "string")) {
      return v as ActionDef<any>[];
    }
  }
  return [];
}

/**
 * Install everything. Idempotent — repeat calls return the first install's result.
 * `router` is the object returned by `createBrowserRouter` (anything with `.navigate`).
 */
export function installAgentLayer(router?: RouterLike | null): Promise<InstallResult> {
  if (installing) return installing;
  installing = (async (): Promise<InstallResult> => {
    const controller = new AbortController();
    const ctx: ActionContext = makeContext({ signal: controller.signal, router: router ?? null });

    // ---- workstream B: the shot resolver + cast index
    // `import.meta.glob` (not a bare dynamic import) so the build stays green while B and C
    // are still writing these files: a missing file yields an empty map, not a resolve error.
    let resolverKind: InstallResult["resolver"] = "fallback";
    const resolveMods = import.meta.glob("./resolve.ts") as Record<string, () => Promise<unknown>>;
    try {
      const load = resolveMods["./resolve.ts"];
      if (load) {
        const r = pickResolver((await load()) as Record<string, unknown>, ctx.api);
        if (r) { setResolver(r); resolverKind = "workstream-b"; }
      }
    } catch (e) { console.warn("[cutroom/agent] resolve.ts failed to load", e); }

    // ---- workstream C: hand the tool layer A's real jobs/guard/registry services.
    // `tools/deps.ts` also self-adopts ../jobs and ../guard, but only A can supply
    // `allActions()` — list_features and show_me are empty without it.
    const depMods = import.meta.glob("./tools/deps.ts") as Record<string, () => Promise<unknown>>;
    try {
      const load = depMods["./tools/deps.ts"];
      if (load) {
        const mod = (await load()) as Record<string, unknown>;
        const installDeps = mod.installDeps as ((p: Record<string, unknown>) => void) | undefined;
        installDeps?.({ settleJobs, classifyBackend, allActions: all });
      }
    } catch (e) { console.warn("[cutroom/agent] tools/deps.ts failed to load", e); }

    // ---- workstream C: the real tool catalogue (may self-register, or export an array)
    const toolMods = import.meta.glob("./tools/index.ts") as Record<string, () => Promise<unknown>>;
    try {
      const load = toolMods["./tools/index.ts"];
      if (load) {
        const mod = (await load()) as Record<string, unknown>;
        const list = pickTools(mod);
        list.forEach((d) => register(d));
        if (!list.length && typeof mod.registerTools === "function") {
          await (mod.registerTools as (c: ActionContext) => unknown)(ctx);
        }
      }
    } catch (e) { console.warn("[cutroom/agent] tools/ failed to load", e); }

    // ---- workstream A: backfill so the spine is testable even with nothing else present
    const smoke = registerSmokeTools();

    refreshToolCount();
    const mode = await installWebMCP(ctx, controller);
    const tools = all().map((d) => d.name);
    if ((import.meta as { env?: Record<string, boolean> }).env?.DEV) {
      console.info(`[cutroom/agent] ${tools.length} actions · WebMCP ${mode} · ` +
                   `resolver ${resolverKind}${smoke.length ? ` · smoke: ${smoke.join(", ")}` : ""}`);
    }
    return { mode, tools, smoke, resolver: resolverKind };
  })();
  return installing;
}
