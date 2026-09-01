/**
 * ⌘K — the human twin of the tool list.
 *
 * Cutroom has ~97 user-facing actions across two rooms, five tabs and four generate sub-tabs.
 * The palette is the registry projected for a person: title, where it lives, and how to do it
 * by hand. Enter runs an arg-less action; anything that needs arguments navigates there and
 * pulses the control so the human finishes it themselves.
 *
 * Owned by workstream A. See docs/WEBMCP-PLAN.md §3.5.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionDef } from "./contract";
import { agentContext } from "./context";
import { pulse } from "./presence";
import { all, perform, whereOf } from "./registry";
import { fillRoute, withQuery } from "./urlState";

const RECENTS_KEY = "cutroom_palette_recents";
const MAX_RECENTS = 8;

function readRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]") as string[]; }
  catch { return []; }
}
function pushRecent(name: string) {
  try {
    const next = [name, ...readRecents().filter((n) => n !== name)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

/** Subsequence match with a light score: exact > prefix > word start > scattered. */
export function fuzzyScore(query: string, haystack: string): number {
  const q = query.toLowerCase().trim();
  const h = haystack.toLowerCase();
  if (!q) return 1;
  if (h === q) return 1000;
  const at = h.indexOf(q);
  if (at === 0) return 500;
  if (at > 0) return 300 - Math.min(at, 100) + (/\W/.test(h[at - 1]) ? 50 : 0);
  let i = 0, hits = 0, streak = 0, best = 0;
  for (const ch of h) {
    if (ch === q[i]) { i++; hits++; streak++; best = Math.max(best, streak); }
    else streak = 0;
    if (i >= q.length) break;
  }
  return i >= q.length ? 40 + hits + best * 2 : 0;
}

export interface PaletteRow { def: ActionDef<any>; score: number }

/** Rank the palette-visible registry against a query. Exported for the unit tests. */
export function filterActions(defs: ActionDef<any>[], query: string,
                              recents: string[] = []): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (const def of defs) {
    if (def.surfaces?.palette === false) continue;
    const rank = recents.indexOf(def.name);
    const recentBoost = rank >= 0 ? (MAX_RECENTS - rank) * 4 : 0;
    if (!query.trim()) { rows.push({ def, score: 1 + recentBoost }); continue; }
    const score = Math.max(
      fuzzyScore(query, def.title) * 3,
      fuzzyScore(query, def.name) * 2,
      fuzzyScore(query, (def.keywords || []).join(" ")) * 2,
      fuzzyScore(query, def.description),
    );
    if (score > 0) rows.push({ def, score: score + recentBoost });
  }
  return rows.sort((a, b) => b.score - a.score || a.def.title.localeCompare(b.def.title));
}

/** An action is runnable straight from the palette when nothing is required of the human. */
export function isArgless(def: ActionDef<any>): boolean {
  return (def.inputSchema?.required || []).length === 0;
}

export default function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>(readRecents);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setCursor(0);
        setNote(null);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);

  const rows = useMemo(() => (open ? filterActions(all(), query, recents) : []),
                       [open, query, recents]);
  const active = rows[Math.min(cursor, Math.max(0, rows.length - 1))];

  const runRow = useCallback(async (def: ActionDef<any>) => {
    const ctx = agentContext();
    pushRecent(def.name);
    setRecents(readRecents());
    const where = whereOf(def, {});
    if (isArgless(def)) {
      setBusy(def.name);
      setOpen(false);
      const res = await perform(def.name, {}, ctx);
      setBusy(null);
      if (!res.ok) setNote(`${def.title}: ${res.error}`);
      return;
    }
    // Needs arguments — take the human to the control and let them finish.
    const route = fillRoute(where.route, { pid: ctx.project, sid: null });
    setOpen(false);
    if (route) {
      try { await ctx.nav(withQuery(route, where.query || {})); } catch { /* still pulse */ }
    }
    if (where.anchor) setTimeout(() => pulse(where.anchor!), 60);
  }, []);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    const el = listRef.current?.querySelector(".pal-row.active");
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, query]);

  if (!open) {
    return note ? <div className="toast agent-toast">{note}</div> : null;
  }

  return (
    <div className="pal-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) setOpen(false);
    }}>
      <div className="pal" role="dialog" aria-label="Cutroom command palette">
        <input
          ref={inputRef}
          className="pal-input"
          placeholder="What do you want to do? (⌘K)"
          value={query}
          data-action="app.palette.input"
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
            else if (e.key === "Enter" && active) { e.preventDefault(); void runRow(active.def); }
          }}
        />
        <div className="pal-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="muted small" style={{ padding: 14 }}>
              nothing matches “{query}”
            </div>
          )}
          {rows.slice(0, 60).map((r, i) => {
            const where = whereOf(r.def, {});
            const on = r.def === active?.def;
            return (
              <div key={r.def.name}
                   className={`pal-row ${on ? "active" : ""}`}
                   onMouseEnter={() => setCursor(i)}
                   onClick={() => void runRow(r.def)}>
                <div className="pal-row-main">
                  <b>{r.def.title}</b>
                  <span className="muted small pal-where">{where.label}</span>
                </div>
                <div className="pal-row-meta">
                  {busy === r.def.name && <span className="chip"><span className="dot busy" /> …</span>}
                  {isArgless(r.def)
                    ? <span className="pal-kbd">run ⏎</span>
                    : <span className="pal-kbd muted">show ⏎</span>}
                </div>
              </div>
            );
          })}
        </div>
        {active && (
          <div className="pal-foot">
            <div className="small">{active.def.howTo || active.def.description}</div>
            <div className="muted small">
              {active.def.name}
              {active.def.annotations?.readOnlyHint ? " · read-only" : ""}
              {active.def.annotations?.consequentialHint ? " · makes changes" : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
