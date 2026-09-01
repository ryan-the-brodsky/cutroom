/**
 * Shot resolver — "shot 37", "the David Ross close-up", "B10-S2" → a shot.
 *
 * Cutroom addresses shots as `B10-S2` sids. Directors do not. This turns any
 * of the four ways a human names a shot (sid, film ordinal, beat, or a
 * description of who and what is in it) into a ranked resolution, and says
 * out loud when two of them disagree — because Ryan's own hero sentence,
 * "make a few more generative cuts of the David Ross close-up", is a
 * different shot from "shot 37", and guessing would be worse than asking.
 *
 * Index sources: `GET /api/projects/{pid}/film` (shots in film order) and
 * `GET /api/projects/{pid}/cast` (the character index the game7 importer
 * builds from prompts/characters.jsonl). Both are cached per project until
 * `index(pid, { force: true })`.
 *
 * See docs/WEBMCP-PLAN.md §3.4. Contract: contract.ts (frozen).
 */
import type {
  Candidate, Confidence, Resolution, ResolvedShot, ShotResolver,
} from "./contract";

type Api = <T = unknown>(path: string, body?: unknown, method?: string) => Promise<T>;

// ------------------------------------------------------------------ wire shapes

export interface FilmEntry {
  sid: string; beat?: string; act?: number; type?: string;
  seconds?: number | null; register?: string;
  image_prompt?: string; negative?: string; motion_prompt?: string | null;
  render_notes?: string | null; curation_note?: string | null;
  dialogue?: { character?: string; line?: string }[];
  keeper?: string | null; active_source?: string | null;
  stills?: string[]; i2i?: string[]; motion?: string[]; crops?: string[];
  fx?: string[]; vo?: string[];
  [k: string]: unknown;
}

export interface CastMember {
  id: string; name: string; aliases: string[]; descriptor?: string;
}

interface IndexedShot extends ResolvedShot {
  /** everything a free-text query may match against, lowercased */
  hay: string;
  /** the part of image_prompt that describes who/what is in frame */
  subject: string;
  /** lowercased image_prompt, for framing words */
  prompt: string;
  castIds: string[];
  speakers: string[];
}

interface ProjectIndex {
  shots: IndexedShot[];
  cast: CastMember[];
  at: number;
}

// module-level cache: one index per project, shared by every tool
const CACHE = new Map<string, ProjectIndex>();

/** Test hook / "the film changed" hook. */
export function clearIndexCache(pid?: string): void {
  if (pid) CACHE.delete(pid);
  else CACHE.clear();
}

// ------------------------------------------------------------------ scoring weights

/** Tuned against the real `next-year` film; see __tests__/resolve.test.ts. */
export const WEIGHTS = {
  sid: 1000,
  ordinal: 600,
  beat: 300,
  cast: 120,
  speaker: 40,      // the cast member also speaks in this shot
  type: 140,        // "close-up" → HERO, "wide" → STILL
  framing: 60,      // the prompt's own framing words agree with the query
  token: 12,        // per distinct free-text token found (× a term-frequency
  tokenCap: 160,    //   bonus that saturates), capped in total
};

/** Below this a match is noise, not an answer: one free-text token is the
 *  weakest thing we will still call a candidate. */
const FLOOR = 12;
/** Top-2 closer than this (relative) is a coin toss, so: ambiguous. */
const AMBIGUOUS_GAP = 0.15;

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "and", "or",
  "is", "it", "its", "that", "this", "these", "those", "my", "me", "i", "we",
  "shot", "shots", "scene", "clip", "take", "takes", "cut", "cuts", "frame",
  "make", "more", "few", "another", "again", "some", "generative", "please",
  "up", "down", "from", "by", "as", "be", "do", "get", "go", "show", "open",
  "s", "th", "st", "nd", "rd", "one", "then", "him", "her", "his", "their",
]);

/** query words → the shot `type` they imply */
const TYPE_WORDS: [RegExp, string][] = [
  [/\b(close[- ]?ups?|cu|hero|insert|tight shots?)\b/i, "HERO"],
  [/\b(wides?|wide shots?|tableaus?|establishing|master)\b/i, "STILL"],
];
/**
 * Framing *phrases* a prompt uses when it is genuinely a close shot. Bare
 * adjectives are not enough: B11-S2's "jaw tight" is a face, not a lens, and
 * matching it made "the David Ross close-up" a coin toss with B10-S2's real
 * "tight over-the-shoulder framing".
 */
const TIGHT_FRAMING =
  /\b(close[- ]?ups?|extreme close|macro|over-the-shoulder|reverent insert|macro insert|(?:tight|intimate|very tight|extreme)(?:\s+[a-z-]+){0,2}\s+(?:framing|shot|insert|detail|close|macro)|tight\s+(?:macro|insert|detail|close|intimate|over-the-shoulder))\b/;
const WIDE_FRAMING =
  /\b(wide(?:\s+[a-z-]+){0,2}\s+(?:framing|shot|tableau|view)|wide low tableau|tableau|establishing|master shot|panoram\w*)\b/;

// ------------------------------------------------------------------ helpers

const norm = (s: string) => (s || "").toLowerCase();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** word-boundary containment that also works for multi-word aliases */
function hasPhrase(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}([^a-z0-9]|$)`, "i")
    .test(haystack);
}

function countPhrase(haystack: string, phrase: string): number {
  if (!phrase) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}(?=[^a-z0-9]|$)`, "gi");
  return (haystack.match(re) || []).length;
}

/** `b10 s2`, `b10-s2`, `b10s2`, `B10_S2` → `B10-S2` */
export function normalizeSid(raw: string): string | null {
  const m = /\bb\s*[-_]?\s*(\d{1,2})\s*[-_ ]?\s*s\s*[-_]?\s*(\d{1,2})\b/i
    .exec(raw);
  if (!m) return null;
  return `B${m[1].padStart(2, "0")}-S${Number(m[2])}`;
}

/** the clause of an image prompt that describes what is in frame */
export function subjectClause(imagePrompt: string): string {
  const ip = imagePrompt || "";
  const subj = /subject:\s*/i.exec(ip);
  if (subj) return ip.slice(subj.index + subj[0].length);
  const dot = ip.indexOf(". ");
  return dot >= 0 ? ip.slice(dot + 2) : ip;
}

/** first 90 chars after "Subject:" if present, else of the prompt itself */
export function summarize(imagePrompt: string): string {
  const ip = (imagePrompt || "").replace(/\s+/g, " ").trim();
  const subj = /subject:\s*/i.exec(ip);
  const body = subj ? ip.slice(subj.index + subj[0].length) : ip;
  return body.length <= 90 ? body : body.slice(0, 89).trimEnd() + "…";
}

// ------------------------------------------------------------------ indexing

export function indexShots(film: FilmEntry[], cast: CastMember[]): IndexedShot[] {
  return film.map((e, i) => {
    const prompt = norm(e.image_prompt || "");
    const subject = norm(subjectClause(e.image_prompt || ""));
    const dialogue = e.dialogue || [];
    const speakerText = norm(dialogue.map((d) => d.character || "").join(" | "));
    const castIds: string[] = [];
    const speakers: string[] = [];
    const characters: string[] = [];
    for (const c of cast) {
      const inSubject = c.aliases.some((a) => hasPhrase(subject, a));
      const inSpeakers = c.aliases.some((a) => hasPhrase(speakerText, a));
      if (inSubject || inSpeakers) {
        castIds.push(c.id);
        characters.push(c.name);
      }
      if (inSpeakers) speakers.push(c.id);
    }
    const hay = norm([
      e.image_prompt, e.register, e.render_notes, e.motion_prompt,
      e.curation_note, dialogue.map((d) => `${d.character || ""} ${d.line || ""}`).join(" "),
    ].filter(Boolean).join(" \n "));
    return {
      sid: e.sid,
      ordinal: i + 1,
      beat: e.beat || "",
      act: typeof e.act === "number" ? e.act : null,
      type: e.type || "STILL",
      seconds: typeof e.seconds === "number" ? e.seconds : null,
      summary: summarize(e.image_prompt || ""),
      characters,
      has_keeper: Boolean(e.keeper),
      has_motion: Boolean((e.motion || []).length || (e.fx || []).length),
      plays: e.active_source ?? null,
      hay, subject, prompt, castIds, speakers,
    };
  });
}

function bare(s: IndexedShot): ResolvedShot {
  const { hay, subject, prompt, castIds, speakers, ...rest } = s;
  return rest;
}

// ------------------------------------------------------------------ query parsing

export interface QueryFacts {
  sid: string | null;
  ordinals: number[];
  beats: string[];
  cast: CastMember[];
  types: string[];
  tokens: string[];
  wantsTight: boolean;
  wantsWide: boolean;
  /** the query names a person or describes the picture, not just a number */
  descriptive: boolean;
}

export function parseQuery(query: string, cast: CastMember[]): QueryFacts {
  const q = norm(query).trim();
  let rest = q;

  const sid = normalizeSid(q);
  if (sid) {
    rest = rest.replace(/\bb\s*[-_]?\s*\d{1,2}\s*[-_ ]?\s*s\s*[-_]?\s*\d{1,2}\b/gi, " ");
  }

  const beats: string[] = [];
  rest = rest.replace(/\bbeat\s*0?(\d{1,2})\b/g, (_m, n) => {
    beats.push(`B${String(n).padStart(2, "0")}`);
    return " ";
  });
  if (!sid) {
    rest = rest.replace(/\bb\s*0?(\d{1,2})\b/g, (_m, n) => {
      beats.push(`B${String(n).padStart(2, "0")}`);
      return " ";
    });
  }

  const ordinals: number[] = [];
  const pushOrd = (n: string) => {
    const v = Number(n);
    if (v >= 1 && v <= 9999) ordinals.push(v);
  };
  rest = rest.replace(/#\s*(\d{1,4})\b/g, (_m, n) => (pushOrd(n), " "));
  rest = rest.replace(/\b(?:shot|number|no\.?)\s*#?\s*(\d{1,4})\b/g, (_m, n) => (pushOrd(n), " "));
  rest = rest.replace(/\bthe\s+(\d{1,4})(?:st|nd|rd|th)\b/g, (_m, n) => (pushOrd(n), " "));
  rest = rest.replace(/\b(\d{1,4})(?:st|nd|rd|th)\b/g, (_m, n) => (pushOrd(n), " "));
  rest = rest.replace(/\b(\d{1,4})\b/g, (_m, n) => (pushOrd(n), " "));

  const types: string[] = [];
  for (const [re, type] of TYPE_WORDS) {
    if (re.test(q) && !types.includes(type)) types.push(type);
    // a consumed shot-type phrase must not also score as free text
    rest = rest.replace(new RegExp(re.source, "gi"), " ");
  }

  const hits = cast.filter((c) => c.aliases.some((a) => hasPhrase(q, a)));

  const tokens = Array.from(new Set(
    rest.split(/[^a-z0-9'-]+/).map((t) => t.replace(/^-+|-+$/g, ""))
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  ));

  return {
    sid, ordinals, beats, cast: hits, types, tokens,
    wantsTight: /\b(close[- ]?ups?|cu|tight|macro|insert|extreme)\b/.test(q),
    wantsWide: /\b(wides?|tableaus?|establishing|master)\b/.test(q),
    descriptive: hits.length > 0 || types.length > 0 || tokens.length > 0,
  };
}

// ------------------------------------------------------------------ scoring

function scoreShot(s: IndexedShot, f: QueryFacts): { score: number; why: string } {
  let score = 0;
  const why: string[] = [];

  if (f.sid && s.sid.toUpperCase() === f.sid.toUpperCase()) {
    score += WEIGHTS.sid;
    why.push(`sid ${s.sid}`);
  }
  if (f.ordinals.includes(s.ordinal)) {
    score += WEIGHTS.ordinal;
    why.push(`#${s.ordinal} in film order`);
  }
  if (f.beats.includes(s.beat.toUpperCase())) {
    score += WEIGHTS.beat;
    why.push(`beat ${s.beat}`);
  }
  for (const c of f.cast) {
    if (s.castIds.includes(c.id)) {
      score += WEIGHTS.cast;
      why.push(c.name);
      if (s.speakers.includes(c.id)) score += WEIGHTS.speaker;
    }
  }
  if (f.types.includes(s.type)) {
    score += WEIGHTS.type;
    why.push(`${s.type} shot`);
  }
  if (f.wantsTight && TIGHT_FRAMING.test(s.prompt)) {
    score += WEIGHTS.framing;
    why.push("tight framing");
  }
  if (f.wantsWide && WIDE_FRAMING.test(s.prompt)) {
    score += WEIGHTS.framing;
    why.push("wide framing");
  }
  let textual = 0;
  const found: string[] = [];
  for (const t of f.tokens) {
    const hits = countPhrase(s.hay, t);
    if (hits) {
      // a prompt that says "dial" thirteen times is more about the dial than
      // one that mentions it in passing — but the bonus saturates fast.
      textual += WEIGHTS.token * (1 + 0.25 * Math.min(hits - 1, 12));
      found.push(t);
    }
  }
  if (textual) {
    score += Math.min(textual, WEIGHTS.tokenCap);
    why.push(`text: ${found.slice(0, 4).join(", ")}`);
  }
  return { score, why: why.join(" · ") };
}

export function resolveAgainst(shots: IndexedShot[], cast: CastMember[],
                               query: string): Resolution {
  const f = parseQuery(query, cast);
  const scored = shots
    .map((s) => ({ s, ...scoreShot(s, f) }))
    .filter((r) => r.score >= FLOOR)
    .sort((a, b) => (b.score - a.score) || (a.s.ordinal - b.s.ordinal));

  if (!scored.length) return { best: null, candidates: [], confidence: "none" };

  const candidates: Candidate[] = scored.slice(0, 8).map((r) => ({
    ...bare(r.s), score: Math.round(r.score), why: r.why,
  }));
  const top = scored[0];
  const second = scored[1];

  // An ordinal and a description that point at different shots is the one
  // case where a confident answer is the wrong answer: surface both.
  const ordinalShot = f.ordinals.length
    ? scored.find((r) => f.ordinals.includes(r.s.ordinal)) : undefined;
  const describedShot = f.cast.length || f.types.length
    ? scored.find((r) => r.s.castIds.some((id) => f.cast.some((c) => c.id === id))
      || f.types.includes(r.s.type))
    : undefined;
  const disagree = Boolean(ordinalShot && describedShot
    && ordinalShot.s.sid !== describedShot.s.sid
    && (f.cast.length > 0 || f.types.length > 0));

  let confidence: Confidence;
  if (disagree) {
    confidence = "ambiguous";
    // both readings must be in the list, whatever the scores said
    for (const r of [ordinalShot!, describedShot!]) {
      if (!candidates.some((c) => c.sid === r.s.sid)) {
        candidates.splice(1, 0, {
          ...bare(r.s), score: Math.round(r.score), why: r.why,
        });
      }
    }
    candidates.length = Math.min(candidates.length, 8);
  } else if (f.sid && top.s.sid.toUpperCase() === f.sid.toUpperCase()) {
    confidence = "exact";
  } else if (second && (top.score - second.score) / top.score < AMBIGUOUS_GAP) {
    confidence = "ambiguous";
  } else {
    confidence = "high";
  }

  return { best: bare(top.s), candidates, confidence };
}

// ------------------------------------------------------------------ the resolver

export function makeResolver(api: Api): ShotResolver {
  async function load(pid: string, force = false): Promise<ProjectIndex> {
    const hit = CACHE.get(pid);
    if (hit && !force) return hit;
    const film = await api<FilmEntry[]>(`/api/projects/${pid}/film`);
    let cast: CastMember[] = [];
    try {
      const res = await api<{ cast?: CastMember[] } | CastMember[]>(
        `/api/projects/${pid}/cast`);
      cast = (Array.isArray(res) ? res : res?.cast) || [];
    } catch {
      cast = [];              // a project imported without characters.jsonl
    }
    const idx: ProjectIndex = {
      shots: indexShots(Array.isArray(film) ? film : [], cast),
      cast, at: Date.now(),
    };
    CACHE.set(pid, idx);
    return idx;
  }

  return {
    async index(pid: string, opts?: { force?: boolean }): Promise<ResolvedShot[]> {
      const idx = await load(pid, Boolean(opts?.force));
      return idx.shots.map(bare);
    },
    async resolve(pid: string, query: string): Promise<Resolution> {
      const idx = await load(pid);
      return resolveAgainst(idx.shots, idx.cast, query || "");
    },
  };
}

export default makeResolver;
