/**
 * Chapters: a cut's EDL turned into something you can seek to.
 *
 * The whole point of the screening room is that "show me the film from the
 * lighthouses" lands on a frame, not a thumbnail. That needs two things: the
 * shot boundaries of the cut (the EDL the assembler already writes), and a
 * grammar for the word the director used. Both live here, pure and testable.
 *
 * Owned by workstream M.
 */
import type { Chapter } from "../agent/contract";

export type { Chapter };

// ------------------------------------------------------------------ lookup

/** Which chapter is on screen at film second `t`. The last one wins past the end. */
export function chapterAt(chapters: Chapter[], t: number): Chapter | null {
  if (!chapters.length) return null;
  const at = Number.isFinite(t) ? Math.max(0, t) : 0;
  let hit: Chapter | null = null;
  for (const c of chapters) {
    if (c.start <= at + 1e-6) hit = c;
    else break;
  }
  if (!hit) return chapters[0];
  // Past the tail of the last chapter is still the last chapter.
  return hit;
}

export const chapterIndexAt = (chapters: Chapter[], t: number): number => {
  const hit = chapterAt(chapters, t);
  return hit ? chapters.indexOf(hit) : -1;
};

/** The chapter `delta` steps away from wherever `t` sits (clamped, never wraps past the ends). */
export function stepChapter(chapters: Chapter[], t: number, delta: number): Chapter | null {
  if (!chapters.length) return null;
  const i = Math.max(0, chapterIndexAt(chapters, t));
  const next = Math.min(chapters.length - 1, Math.max(0, i + delta));
  return chapters[next];
}

export const totalOf = (chapters: Chapter[]): number =>
  chapters.length ? chapters[chapters.length - 1].start + chapters[chapters.length - 1].seconds : 0;

// ------------------------------------------------------------------ the `from` grammar

const SID_RE = /^[a-z]?\d{1,3}[-_]?s?\d{1,3}$/i;

/** "1:05" / "1:02:03" / "65" / 65 → seconds. Null when it is not a clock at all. */
export function parseTime(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.max(0, raw) : null;
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const clock = /^(\d{1,2}):([0-5]?\d)(?::([0-5]?\d))?(\.\d+)?$/.exec(s);
  if (clock) {
    const [, a, b, c, frac] = clock;
    const parts = c === undefined
      ? [Number(a), Number(b)]                  // mm:ss
      : [Number(a), Number(b), Number(c)];      // hh:mm:ss
    const secs = parts.length === 2
      ? parts[0] * 60 + parts[1]
      : parts[0] * 3600 + parts[1] * 60 + parts[2];
    return secs + (frac ? Number(frac) : 0);
  }
  if (/^\d+(\.\d+)?s?$/.test(s)) return Math.max(0, parseFloat(s));
  return null;
}

export const mmss = (t: number): string => {
  const s = Math.max(0, Math.floor(Number(t) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export interface FromHit { seconds: number; how: string; sid?: string }

export interface FromOptions {
  duration?: number | null;
  /** sid → act number, for "act2". Only consulted when the word is an act. */
  actOf?: (sid: string) => number | null | undefined;
}

/**
 * Resolve the director's word for "from where" into film seconds.
 *
 * Understood here: a number, "65", "1:05", "1:02:03", "start"/"top",
 * "end", a shot sid ("B03-S2"), and "act2"/"act 2". Anything else returns
 * null and the caller falls back to the shot resolver, which is what turns
 * "from the lighthouses" into a seek.
 */
export function parseFrom(
  raw: unknown, chapters: Chapter[], opts: FromOptions = {},
): FromHit | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const duration = opts.duration ?? (chapters.length ? totalOf(chapters) : null);

  const clock = parseTime(raw);
  if (clock !== null) {
    const at = duration ? Math.min(clock, Math.max(0, duration - 0.05)) : clock;
    const hit = chapterAt(chapters, at);
    return { seconds: at, how: `${mmss(at)}`, ...(hit ? { sid: hit.sid } : {}) };
  }

  const s = String(raw).trim();
  const word = s.toLowerCase();

  if (/^(the )?(start|beginning|top|head|first frame)$/.test(word)) {
    return { seconds: 0, how: "the top", ...(chapters[0] ? { sid: chapters[0].sid } : {}) };
  }
  if (/^(the )?end$/.test(word) && duration) {
    const at = Math.max(0, duration - 5);
    const hit = chapterAt(chapters, at);
    return { seconds: at, how: "the last five seconds", ...(hit ? { sid: hit.sid } : {}) };
  }

  const act = /^act\s*([1-9])$/.exec(word);
  if (act && opts.actOf) {
    const want = Number(act[1]);
    const hit = chapters.find((c) => opts.actOf!(c.sid) === want);
    if (hit) return { seconds: hit.start, how: `act ${want} (${hit.sid})`, sid: hit.sid };
    return null;
  }

  const exact = chapters.find((c) => c.sid.toLowerCase() === word);
  if (exact) return { seconds: exact.start, how: exact.sid, sid: exact.sid };
  if (SID_RE.test(word)) {
    const loose = chapters.find((c) => c.sid.toLowerCase().replace(/[^a-z0-9]/g, "")
      === word.replace(/[^a-z0-9]/g, ""));
    if (loose) return { seconds: loose.start, how: loose.sid, sid: loose.sid };
  }
  return null;
}

/** Where a sid starts in this cut, if it is in it at all. */
export function chapterOf(chapters: Chapter[], sid: string): Chapter | null {
  const want = String(sid || "").toLowerCase();
  return chapters.find((c) => c.sid.toLowerCase() === want) ?? null;
}

// ------------------------------------------------------------------ fetching

export interface EdlResponse {
  cut?: string; scope?: string; total?: number | null; shots?: number;
  edl?: Chapter[];
}

/**
 * The cut's chapters. Served by `GET /projects/{pid}/cuts/{name}/edl`, which
 * reads the take's `meta.edl` and recomputes from the film when an older cut
 * was recorded without one.
 */
export async function fetchChapters(
  api: <T>(path: string, body?: unknown, method?: string) => Promise<T>,
  pid: string, rel: string,
): Promise<{ chapters: Chapter[]; total: number | null }> {
  try {
    const d = await api<EdlResponse>(
      `/api/projects/${pid}/cuts/${rel.split("/").map(encodeURIComponent).join("/")}/edl`);
    const chapters = (d?.edl || []).filter((c) => c && typeof c.sid === "string").map((c) => ({
      sid: c.sid, start: Number(c.start) || 0, seconds: Number(c.seconds) || 0,
      source: c.source ?? null,
    }));
    const total = typeof d?.total === "number" ? d.total
      : chapters.length ? totalOf(chapters) : null;
    return { chapters, total };
  } catch {
    return { chapters: [], total: null };
  }
}
