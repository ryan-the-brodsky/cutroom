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
