/**
 * Vitest environment shims (harness-owned; workstream E).
 *
 * jsdom 25 does not implement the `CSS` interface, so `CSS.escape()` — which
 * `contract.ts#anchorSelector` calls — throws "Cannot read properties of
 * undefined". Real Chrome has it, so this is a test-environment gap only.
 * Minimal spec-compliant-enough escape for the identifiers we generate.
 */
if (typeof (globalThis as { CSS?: unknown }).CSS === "undefined") {
  (globalThis as { CSS?: unknown }).CSS = {};
}
const css = (globalThis as { CSS: { escape?: (v: string) => string } }).CSS;
if (typeof css.escape !== "function") {
  css.escape = (value: string): string =>
    String(value).replace(/[^\w-]/g, (ch) =>
      ch === "\0" ? "�" : `\\${ch.codePointAt(0)!.toString(16)} `,
    );
}

/**
 * Node 26 ships an experimental `globalThis.localStorage` that shadows jsdom's and
 * THROWS unless `--localstorage-file` is given. `src/api.ts` reads it at import time,
 * so without this every test that pulls in an app module dies at collection.
 * (Workstream A hit this and shimmed it per-file in `src/agent/__tests__/_env.ts`;
 * hoisted here so every test gets it for free. A's per-file import stays harmless.)
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  } as Storage;
}
const store = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const usable = (s: unknown) => { try { (s as Storage)?.getItem("__probe__"); return true; } catch { return false; } };
if (!store.localStorage || !usable(store.localStorage)) store.localStorage = memoryStorage();
if (!store.sessionStorage || !usable(store.sessionStorage)) store.sessionStorage = memoryStorage();
