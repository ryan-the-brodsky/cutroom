/**
 * Environment shim for this Node build: `globalThis.localStorage` is absent (Node's own
 * experimental localStorage needs --localstorage-file, and it shadows jsdom's), so any module
 * that reads it at import time — `src/api.ts` does — explodes on collection.
 *
 * Import this FIRST in a test file that pulls in app modules. Harmless in real browsers.
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

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const usable = (s: unknown) => {
  try { (s as Storage)?.getItem("__probe__"); return true; } catch { return false; }
};
if (!g.localStorage || !usable(g.localStorage)) g.localStorage = memoryStorage();
if (!g.sessionStorage || !usable(g.sessionStorage)) g.sessionStorage = memoryStorage();

export {};
