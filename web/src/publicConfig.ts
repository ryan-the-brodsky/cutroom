/**
 * `/api/public` — the one endpoint that answers without a token.
 *
 * Both the landing page and the access gate render before anyone is authenticated, so
 * neither can go through `api()` (which sends a bearer and throws on 401). This reads the
 * public config directly, once per page load, and degrades to "nothing configured" on any
 * failure: an unreachable API must never turn the front page into an error screen.
 *
 * The two links are read from the server at runtime, not baked into the bundle, so the
 * owner sets `CUTROOM_ACCESS_FORM_URL` / `CUTROOM_DEMO_VIDEO_URL` on the host and the next
 * page load has them without a rebuild.
 */
import { useEffect, useState } from "react";

export interface PublicFilm {
  /** Streamed by the server with Range support, so `<video>` can seek. */
  url: string;
  label: string;
  seconds: number | null;
}

export interface PublicConfig {
  /** Google Form for an invite. Empty means "render no button", not "render a dead one". */
  access_form_url: string;
  /** YouTube walkthrough. Empty until it is recorded. */
  video_url: string;
  film: PublicFilm | null;
}

const BASE = (import.meta as any).env?.VITE_API_BASE || "";

export const EMPTY_PUBLIC_CONFIG: PublicConfig = {
  access_form_url: "", video_url: "", film: null,
};

let pending: Promise<PublicConfig> | null = null;

/** Fetched at most once per page load; every caller shares the same promise. */
export function publicConfig(): Promise<PublicConfig> {
  if (!pending) {
    pending = fetch(`${BASE}/api/public`)
      .then((r) => (r.ok ? r.json() : EMPTY_PUBLIC_CONFIG))
      .then((c: Partial<PublicConfig>) => ({ ...EMPTY_PUBLIC_CONFIG, ...c }))
      .catch(() => EMPTY_PUBLIC_CONFIG);
  }
  return pending;
}

/** Test hook: drop the memoised fetch. */
export function resetPublicConfig(): void {
  pending = null;
}

export function usePublicConfig(): PublicConfig {
  const [cfg, setCfg] = useState<PublicConfig>(EMPTY_PUBLIC_CONFIG);
  useEffect(() => {
    let live = true;
    void publicConfig().then((c) => { if (live) setCfg(c); });
    return () => { live = false; };
  }, []);
  return cfg;
}

/**
 * The privacy-enhanced embed URL for a YouTube link, or null if it is not one.
 *
 * The owner will paste whatever the share sheet gave them — `watch?v=`, `youtu.be/`,
 * `/shorts/`, already-an-embed — and all four have to work. Anything else (a Vimeo link,
 * a typo) returns null and the page shows a plain link instead of an iframe pointed at
 * nothing.
 */
export function youtubeEmbed(url: string): string | null {
  const id = youtubeId(url);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

export function youtubeId(url: string): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  const path = u.pathname.split("/").filter(Boolean);
  let id = "";
  if (host === "youtu.be") id = path[0] || "";
  else if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    if (path[0] === "embed" || path[0] === "shorts" || path[0] === "live") id = path[1] || "";
    else id = u.searchParams.get("v") || "";
  }
  return /^[\w-]{6,20}$/.test(id) ? id : null;
}
