/**
 * The action registry — one source of truth, three surfaces.
 *
 * Every feature is an `ActionDef`; WebMCP tools, the ⌘K palette and "show me" are all
 * projections of what is registered here. `perform()` is the single execution path:
 * validate → stamp the trail → execute → clip → never throw.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.1.
 */
import {
  BUDGETS, TOOL_NAME_RE, clip, err,
  type ActionContext, type ActionDef, type JSONSchema, type ToolResult, type Where,
} from "./contract";

const defs = new Map<string, ActionDef<any>>();

/** Register an action. Later registrations of the same name replace earlier ones. */
export function register<A = Record<string, unknown>>(def: ActionDef<A>): ActionDef<A> {
  defs.set(def.name, def as ActionDef<any>);
  return def;
}

export function registerAll(list: ActionDef<any>[]): void { list.forEach((d) => register(d)); }

export function get(name: string): ActionDef<any> | undefined { return defs.get(name); }

export function all(): ActionDef<any>[] { return [...defs.values()]; }

/** Test seam. */
export function __reset(): void { defs.clear(); }

/** Resolve `where`, which may be a function of the args. */
export function whereOf(def: ActionDef<any>, args: Record<string, unknown> = {}): Where {
  return typeof def.where === "function" ? def.where(args) : def.where;
}

// ------------------------------------------------------------------ validation
// "Validate strictly in code, loosely in schema" (Chrome guidance). Agents send strings for
// numbers all the time; coerce the obvious cases, reject the rest with a usable message.

export type Validation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; hint: string };

const typeName = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

function coerce(v: unknown, s: JSONSchema): unknown {
  if (v === undefined || v === null) return v;
  switch (s.type) {
    case "number":
    case "integer":
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      return v;
    case "boolean":
      if (v === "true") return true;
      if (v === "false") return false;
      return v;
    case "string":
      return typeof v === "number" || typeof v === "boolean" ? String(v) : v;
    case "array":
      if (typeof v === "string") {
        const t = v.trim();
        if (t.startsWith("[")) { try { return JSON.parse(t); } catch { /* fall through */ } }
        return t === "" ? [] : t.split(",").map((x) => x.trim());
      }
      return v;
    default:
      return v;
  }
}

function checkValue(path: string, v: unknown, s: JSONSchema, out: string[]): unknown {
  const val = coerce(v, s);
  if (s.type) {
    const t = typeName(val);
    const wanted = s.type === "integer" ? "number" : s.type;
    if (t !== wanted) { out.push(`${path}: expected ${s.type}, got ${t}`); return val; }
    if (s.type === "integer" && !Number.isInteger(val as number)) {
      out.push(`${path}: expected an integer`); return val;
    }
  }
  if (s.enum && !s.enum.includes(val as string | number)) {
    out.push(`${path}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof val === "number") {
    if (s.minimum !== undefined && val < s.minimum) out.push(`${path}: minimum ${s.minimum}`);
    if (s.maximum !== undefined && val > s.maximum) out.push(`${path}: maximum ${s.maximum}`);
  }
  if (Array.isArray(val)) {
    if (s.minItems !== undefined && val.length < s.minItems) out.push(`${path}: at least ${s.minItems} items`);
    if (s.maxItems !== undefined && val.length > s.maxItems) out.push(`${path}: at most ${s.maxItems} items`);
    if (s.items) return val.map((x, i) => checkValue(`${path}[${i}]`, x, s.items!, out));
  }
  if (s.type === "object" && val && typeof val === "object") {
    return checkObject(path, val as Record<string, unknown>, s, out);
  }
  return val;
}

function checkObject(path: string, args: Record<string, unknown>, schema: JSONSchema,
                     out: string[]): Record<string, unknown> {
  const props = schema.properties || {};
  const value: Record<string, unknown> = {};
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      out.push(`${path ? `${path}.` : ""}${key} is required`);
    }
  }
  for (const [key, sub] of Object.entries(props)) {
    const raw = args[key];
    if (raw === undefined || raw === null) {
      if (sub.default !== undefined) value[key] = sub.default;
      continue;
    }
    value[key] = checkValue(`${path ? `${path}.` : ""}${key}`, raw, sub, out);
  }
  if (schema.additionalProperties !== false) {
    for (const [k, v] of Object.entries(args)) if (!(k in props)) value[k] = v;
  }
  return value;
}

/** Validate (and lightly coerce) `args` against an `inputSchema`. */
export function validateArgs(schema: JSONSchema | undefined,
                             args: Record<string, unknown>): Validation {
  if (!schema || schema.type !== "object") return { ok: true, value: args };
  const problems: string[] = [];
  const value = checkObject("", args || {}, schema, problems);
  if (problems.length) {
    return {
      ok: false,
      error: "invalid_arguments",
      hint: problems.slice(0, 6).join("; "),
    };
  }
  return { ok: true, value };
}

// ------------------------------------------------------------------ perform

/** Normalize whatever an agent returned into a ToolResult. */
function asResult(v: unknown): ToolResult {
  if (v && typeof v === "object" && "ok" in (v as Record<string, unknown>)) return v as ToolResult;
  if (typeof v === "string") return { ok: true, summary: v };
  return { ok: true, summary: "done", result: v };
}

/**
 * Run an action. This is the ONLY execution path (WebMCP bridge, palette and tests all use it).
 * It never throws and never rejects: a rejection out of a WebMCP `execute` surfaces to the agent
 * as an opaque UnknownError, which is unrecoverable.
 */
export async function perform(name: string, args: Record<string, unknown> | undefined,
                              ctx: ActionContext): Promise<ToolResult> {
  const def = defs.get(name);
  if (!def) {
    return err("unknown_tool", {
      hint: `no tool named "${name}". Known: ${all().map((d) => d.name).join(", ")}`,
    });
  }
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const v = validateArgs(def.inputSchema, input);
  if (!v.ok) return err(v.error, { hint: v.hint, tool: name });
  const value = v.value;

  try {
    const detail = def.summarize ? safeSummary(def, value) : undefined;
    await ctx.trail.step({ tool: name, title: `→ ${def.title}`, detail });
  } catch { /* the trail must never break a tool */ }

  try {
    const out = await def.execute(value as never, ctx);
    return clip(asResult(out), BUDGETS.output);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") {
      return err("aborted", { hint: "the caller cancelled this tool", tool: name });
    }
    const message = (e as Error)?.message || String(e);
    return err(message.slice(0, 300), { hint: "the action failed; nothing was retried", tool: name });
  }
}

function safeSummary(def: ActionDef<any>, args: Record<string, unknown>): string | undefined {
  try { return def.summarize?.(args as never); } catch { return undefined; }
}

// ------------------------------------------------------------------ contract self-check

export interface RegistryProblem { name: string; problem: string }

/** Budget/shape audit over everything registered — asserted by the unit tests. */
export function auditRegistry(list: ActionDef<any>[] = all()): RegistryProblem[] {
  const out: RegistryProblem[] = [];
  const seen = new Set<string>();
  for (const d of list) {
    const bad = (problem: string) => out.push({ name: d.name, problem });
    if (!TOOL_NAME_RE.test(d.name)) bad(`name must match ${TOOL_NAME_RE}`);
    if (d.name.length > BUDGETS.name) bad(`name > ${BUDGETS.name} chars`);
    if (seen.has(d.name)) bad("duplicate name");
    seen.add(d.name);
    if (!d.title) bad("missing title");
    if (!d.description) bad("missing description");
    if (d.description && d.description.length > BUDGETS.description) {
      bad(`description ${d.description.length} > ${BUDGETS.description} chars`);
    }
    if (!d.inputSchema || d.inputSchema.type !== "object") bad("inputSchema must be an object schema");
    for (const [k, s] of Object.entries(d.inputSchema?.properties || {})) {
      if (s.description && s.description.length > BUDGETS.param) {
        bad(`param "${k}" description ${s.description.length} > ${BUDGETS.param} chars`);
      }
    }
    const w = (() => { try { return whereOf(d, {}); } catch { return null; } })();
    if (!w || !w.label) bad("where.label is required");
    if (!d.howTo) bad("howTo is required (the human path)");
  }
  return out;
}
