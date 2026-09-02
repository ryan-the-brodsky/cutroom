import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import {
  ANCHORS, genFieldAnchor, genSubAnchor, shotTabAnchor,
  type CueField, type CueKind, type CuePlacement, type CueRecord,
  type GenField, type GenSub, type KindFilter, type RefRole, type ShotReference,
  type ShotTab, type TakeLite, type VoField,
} from "../agent/contract";
import { usePageHandles } from "../agent/pageHandles";
import { pick, useQueryState } from "../agent/urlState";
import CompEditor from "../components/CompEditor";
import ModelPicker from "../components/ModelPicker";
import ShotMonitor from "../components/ShotMonitor";
import * as screen from "../screen/store";
import PlanPreview from "../components/PlanPreview";
import RegionCanvas from "../components/RegionCanvas";
import SeparateCanvas from "../components/SeparateCanvas";
import { ANIME_CLAUSE, saysAnime, withAnimeClause } from "../agent/tools/plan";
import { pushToast, useAsync, useJobWatch, usePlateDims, usePoll } from "../hooks";
import { chatPath, filmPath } from "../routes";
import type { FilmEntry, Plan } from "../types";

/** SHOT EDITOR — granular, single-shot composition & editing. The Film
 * Editor arranges; this room is where one shot gets built.
 *
 * tab / sub / take / kind live in the QUERY STRING, so every state of this room is a link:
 * /p/next-year/shot/B10-S2?tab=generate&sub=still — which is also how the agent layer
 * navigates (docs/WEBMCP-PLAN.md §3.3). */

const WORK_TABS: { id: ShotTab; label: string }[] = [
  { id: "compose", label: "compose" },
  { id: "generate", label: "generate" },
  { id: "motion", label: "motion edits" },
  { id: "audio", label: "audio" },
  { id: "script", label: "script" },
];
const TAB_IDS = WORK_TABS.map((t) => t.id) as ShotTab[];
const GEN_SUBS: GenSub[] = ["still", "restyle", "animate", "chain"];
const KIND_FILTERS: KindFilter[] = ["all", "stills", "i2i", "motion", "fx", "crops"];
const IS_CLIP = (p: string | null) => !!p && /\.(mp4|webm|mov)$/i.test(p);
/** What a line can be heard through. Mirrors `engine.audio.TREATMENT_NAMES`;
 *  `none` is the default because the platform has no house sound. */
const VO_TREATMENTS = ["none", "radio", "phone", "megaphone", "hall"];
/** What a reference image is for. The server puts a sentence for each in
 *  front of the picture, so "setting" is matched and not copied wholesale. */
const REF_ROLES: RefRole[] = ["character", "prop", "setting", "style"];
const IS_STILL = (p: string) => /\.(png|jpe?g|webp)$/i.test(p);
/** What "animate from" accepts besides an explicit take path. */
const SOURCE_WORDS = ["keeper", "selected"];

export default function ShotPage() {
  const { pid, sid } = useParams() as { pid: string; sid: string };
  const { data: shot, refresh } =
    usePoll<FilmEntry>(`/api/projects/${pid}/shots/${sid}`, 0);
  const [q, setQ] = useQueryState();
  const tab = pick(q, "tab", TAB_IDS, "compose");
  const sub = pick(q, "sub", GEN_SUBS, "still");
  const kindFilter = pick(q, "kind", KIND_FILTERS, "all");
  const sel = q.get("take");
  const setSel = (p: string | null) => setQ({ take: p });
  const setTab = (t: ShotTab) => setQ({ tab: t });
  const setSub = (s: GenSub) => setQ({ sub: s });
  const setKindFilter = (k: KindFilter) => setQ({ kind: k });
  const [plan, setPlan] = useState<{ plan: Plan; source: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [watchJob, setWatchJob] = useState<string | null>(null);
  // The active comp lives in the query too, so ?tab=compose&comp=<cid> is a real link
  // (and the way the agent's cel tools land on one particular workbench).
  const activeComp = q.get("comp");
  const setActiveComp = (c: string | null) => setQ({ comp: c });
  const [separating, setSeparating] = useState(false);
  /** What the ★ keeper / ⬆ timeline source row last said. Those buttons post
   *  straight to the API, so without this a 4xx (a viewer token on an
   *  owner-only endpoint, a path the project does not have) looked exactly
   *  like the button doing nothing at all. */
  const [takeNote, setTakeNote] = useState<{ text: string; bad: boolean } | null>(null);
  // The References strip's "add from takes" picker (path + what it is for).
  const [refPick, setRefPick] = useState<{ path: string; role: RefRole }>(
    { path: "", role: "character" });
  const { busy, error, run, setError } = useAsync();

  const [gen, setGen] = useState<any>({ backend: "", model: "", seeds: "",
    prompt: "", denoise: 0.85, frames: "", seconds: 5, steps: "", cfg: "", live: 1.0,
    freeze_after: "", region: null as number[] | null, fullFrame: false,
    voice: "", text: "", treatment: "none", beats:
      '[{"prompt": "", "live": 1.0, "breath": 0.4}]' });
  // The Music & SFX console (Audio tab). Kept apart from `gen` so a VO
  // backend pick can't leak into a music submission.
  const [cue, setCue] = useState<any>({
    music: { prompt: "", seconds: 30, instrumental: true, gain: -16 },
    sfx: { prompt: "", seconds: 3, influence: "", gain: -8 } });
  const { data: cueSheet, refresh: refreshCues } =
    usePoll<{ music: CueRecord[]; sfx: CueRecord[] }>(
      `/api/projects/${pid}/cues`, 0);

  const selected = sel || shot?.active_source || null;
  const plate = shot?.keeper || shot?.stills[0] || null;
  const plateDims = usePlateDims(pid, plate);

  /** WHICH IMAGE animate / chain start from. The keeper is the default — it is
   *  the curated plate everything else builds on — but "selected" (or an
   *  explicit path an agent sets) points the lane at the still on the monitor
   *  instead. Selecting a take alone never moved the source, which is how a
   *  clip came back animated from the keeper the director had moved past. */
  const genSourceWord = String(gen.source || "keeper");
  const genSourceWant = genSourceWord === "keeper" ? plate
    : genSourceWord === "selected" ? selected : genSourceWord;
  const motionPlate = genSourceWant && IS_STILL(genSourceWant) ? genSourceWant : null;
  const motionPlateDims = usePlateDims(pid, motionPlate);
  /** What the "animate from" picker shows. A tool pins an explicit path (so the
   *  submission matches what it reported); when that path IS the keeper the
   *  picker still reads "keeper", which is what the director cares about. */
  const genSourcePick = SOURCE_WORDS.includes(genSourceWord) ? genSourceWord
    : genSourceWant === plate ? "keeper" : "take";
  const motionPlateWhy = motionPlate ? "" : genSourceWord === "keeper"
    ? "no plate — set a keeper still first"
    : genSourceWant
      ? `${genSourceWant.split("/").pop()} is not a still — pick a still, or animate from the keeper`
      : "nothing is selected — click a still in the takes rail, or animate from the keeper";

  useJobWatch(watchJob, (ok, result) => {
    setWatchJob(null);
    pushToast({ text: ok ? "✓ job finished — takes updated"
                         : "✗ job failed (see Jobs)",
                job: watchJob || undefined });
    refresh();
    const newTake = result?.takes?.[0] || result?.composite || result?.take;
    if (ok && newTake) setSel(newTake);
  });

  const gallery = useMemo(() => {
    if (!shot) return [] as { path: string; kind: string }[];
    const rows: { path: string; kind: string }[] = [];
    const add = (paths: string[], kind: string) =>
      paths.forEach((p) => rows.push({ path: p, kind }));
    if (kindFilter === "all" || kindFilter === "stills") add(shot.stills, "still");
    if (kindFilter === "all" || kindFilter === "i2i") add(shot.i2i, "i2i");
    if (kindFilter === "all" || kindFilter === "motion") add(shot.motion, "motion");
    if (kindFilter === "all" || kindFilter === "fx") add(shot.fx, "fx");
    if (kindFilter === "crops") add(shot.crops, "crop");
    return rows;
  }, [shot, kindFilter]);

  // ------------------------------------------------------- the handlers (buttons AND agent)
  // Every control below calls one of these; so does the agent layer via page handles, so a
  // tool submission is byte-for-byte the submission a human makes.

  const numOr = (v: any, d?: number) =>
    v === "" || v === null || v === undefined ? d : Number(v);

  const submitGen = async (lane: string, body: any) => {
    let why = "";
    const d = await run(() => api<{ job: string; pool?: string }>(
      `/api/projects/${pid}/generate/${lane}`, { shot: sid, ...body })
      .catch((e: any) => { why = e?.detail || e?.message || String(e); throw e; }),
      (v: any) => { pushToast({ text: `${lane} queued`, job: v.job });
                    setWatchJob(v.job); });
    // The agent layer reads this message verbatim — carry the server's reason.
    if (!d?.job) throw new Error(`${lane} did not queue — ${why || "see the error above"}`);
    return d;
  };
  const fire = (p: Promise<unknown>) => { void p.catch(() => {}); };

  // `references` here are ONE-OFF: the shot's own attached references ride on
  // every generation server-side, this is the extra an agent passes for one call.
  const oneOffRefs = () =>
    Array.isArray(gen.references) && gen.references.length
      ? gen.references : undefined;

  const genStill = () => submitGen("still", {
    prompt: gen.prompt || shot?.image_prompt,
    negative: shot?.negative, name: sid,
    backend: gen.backend || undefined, model: gen.model || undefined,
    references: oneOffRefs(),
    seeds: gen.seeds ? String(gen.seeds).split(",").map(Number) : undefined });

  /** The frame a restyle edits: the monitor selection unless a source was
   *  named (an agent can point at the keeper or any path without moving the
   *  director's view). */
  const restyleSource = !gen.source || gen.source === "selected" ? selected
    : gen.source === "keeper" ? plate : String(gen.source);

  const genRestyle = () => submitGen("i2i", {
    source: restyleSource, prompt: gen.prompt, denoise: gen.denoise,
    name: `${sid}-i2i`, backend: gen.backend || undefined,
    references: oneOffRefs(),
    model: gen.model || undefined });

  /** Refuse rather than quietly animate the keeper: the console was pointed at
   *  a source that is not a still, and silently substituting one is the bug. */
  const refuseSource = (lane: string) => {
    const why = `${lane} needs a still to start from — ${motionPlateWhy}`;
    setError(why);
    return Promise.reject(new Error(why));
  };

  const genAnimate = () => !motionPlate ? refuseSource("animate") : submitGen("motion", {
    plate: motionPlate, prompt: gen.prompt || shot?.motion_prompt,
    region: gen.fullFrame ? undefined : gen.region,
    // Seconds is the unit of direction; frames only when the director typed a count.
    seconds: numOr(gen.seconds), frames: numOr(gen.frames), steps: numOr(gen.steps), cfg: numOr(gen.cfg),
    freeze_after: numOr(gen.freeze_after),
    name: `${sid}-${gen.fullFrame ? "full" : "cel"}`,
    backend: gen.backend || undefined, model: gen.model || undefined });

  const genChain = () => {
    if (!motionPlate) return refuseSource("chain");
    let beats: any;
    try { beats = JSON.parse(gen.beats); }
    catch { setError("beats is not valid JSON");
            return Promise.reject(new Error("beats is not valid JSON")); }
    return submitGen("chain", { plate: motionPlate, beats, name: `${sid}-chain` });
  };

  const submitBySub = (s: GenSub) => (
    s === "restyle" ? genRestyle() : s === "animate" ? genAnimate()
      : s === "chain" ? genChain() : genStill());

  const submitFreeze = () => submitGen("freeze", { source: selected, live: gen.live });
  const submitTrim = (end: number) => submitGen("trim", { source: selected, end });
  const submitVo = () => submitGen("vo", {
    text: gen.text || shot?.narration, voice: gen.voice || undefined,
    backend: gen.backend || undefined, treatment: gen.treatment,
    name: `${sid}_vo` });

  // --- music & SFX: generate, then place what came back as a cue ---------
  const submitMusic = () => submitGen("music", {
    prompt: cue.music.prompt, seconds: Number(cue.music.seconds) || 30,
    instrumental: !!cue.music.instrumental,
    backend: gen.backend || undefined, name: `${sid}-music` });
  const submitSfx = () => submitGen("sfx", {
    prompt: cue.sfx.prompt, seconds: Number(cue.sfx.seconds) || 3,
    prompt_influence: cue.sfx.influence === "" ? undefined
      : Number(cue.sfx.influence),
    backend: gen.backend || undefined, name: `${sid}-sfx` });

  const addCue = async (c: CuePlacement): Promise<CueRecord> => {
    const d = await api<{ cue: CueRecord; at: number | null }>(
      `/api/projects/${pid}/cues`, c);
    refreshCues();
    return { ...d.cue, at: d.at };
  };
  const removeCue = async (id: string) => {
    await api(`/api/projects/${pid}/cues/${id}/delete`, {});
    refreshCues();
  };
  /** The cues that fire on THIS shot — what the audio tab lists. */
  const shotCues: CueRecord[] = useMemo(() => {
    const rows = [...(cueSheet?.music || []), ...(cueSheet?.sfx || [])];
    return rows.filter((c) => c.shot === sid);
  }, [cueSheet, sid]);

  const setOverride = (patch: Record<string, unknown>) =>
    api(`/api/projects/${pid}/shots/${sid}/override`, patch).then(() => refresh());

  // --- references: the pictures this shot's generations are conditioned on ---
  const references: ShotReference[] = (shot?.references as ShotReference[]) || [];
  const postRefs = async (body: Record<string, unknown>) => {
    const d = await api<{ refs: ShotReference[] }>(
      `/api/projects/${pid}/shots/${sid}/refs`, body);
    refresh();
    return d.refs || [];
  };
  const addReference = (ref: ShotReference) => postRefs({ add: ref });
  const removeReference = (which: string) => postRefs({ remove: which });
  /** Run a take-row action so its outcome is visible either way: the row says
   *  what happened, a toast repeats it, and the promise still rejects so the
   *  agent layer gets the server's own reason. */
  const takeAction = async <T,>(what: string, p: Promise<T>): Promise<T> => {
    setTakeNote(null);
    try {
      const v = await p;
      setTakeNote({ text: `${what} ✓`, bad: false });
      pushToast({ text: `${what} ✓` });
      return v;
    } catch (e: any) {
      const why = e?.detail || e?.message || String(e);
      setTakeNote({ text: `${what} failed — ${why}`, bad: true });
      pushToast({ text: `✗ ${what} failed — ${String(why).slice(0, 120)}` });
      throw e;
    }
  };

  const setKeeperPath = async (path: string, note?: string): Promise<void> => {
    const d = await takeAction(`★ keeper — ${path.split("/").pop()}`,
      api<{ keeper?: string }>(`/api/projects/${pid}/shots/${sid}/curate`,
        { keeper: path, ...(note ? { note } : {}) }));
    refresh();
    // The server echoes the pick; if it ever came back as something else the
    // page would be lying about which plate the next motion job starts from.
    if (d?.keeper && d.keeper !== path) {
      setTakeNote({ text: `keeper is ${d.keeper}, not ${path}`, bad: true });
      throw new Error(`the server kept ${d.keeper}, not ${path}`);
    }
  };

  const direct = () => run(
    () => api(`/api/projects/${pid}/direct`,
              { instruction, shot: sid, asset: selected || undefined }),
    (d: any) => setPlan({ plan: d.plan, source: d.source }));

  const directHandle = async (text: string) => {
    setInstruction(text);
    try {
      const d = await api<any>(`/api/projects/${pid}/direct`,
        { instruction: text, shot: sid, asset: selected || undefined });
      setPlan({ plan: d.plan, source: d.source });
      return { plan: d.plan };
    } catch (e) { return { error: (e as Error).message }; }
  };

  const applyPlanHandle = async (p: unknown) => {
    const d = await api<any>(`/api/projects/${pid}/plan/apply`, p);
    setPlan(null);
    const j = d.results?.find((r: any) => r.job)?.job;
    if (j) setWatchJob(j);
    await refresh();
    return { results: d.results as unknown[], note: d.note };
  };

  // --------------------------------------------------------------- agent page handles
  const takesLite: TakeLite[] = useMemo(() => {
    if (!shot) return [];
    const rows: TakeLite[] = [];
    const add = (paths: string[] | undefined, kind: string) =>
      (paths || []).forEach((p) => rows.push({ path: p, kind }));
    add(shot.stills, "still"); add(shot.i2i, "i2i"); add(shot.motion, "motion");
    add(shot.fx, "fx"); add(shot.crops, "crop"); add(shot.vo, "vo");
    return rows;
  }, [shot]);

  usePageHandles({
    kind: "shot", pid, sid,
    getState: () => ({
      tab, sub, kindFilter,
      selected, activeSource: shot?.active_source ?? null,
      keeper: shot?.keeper ?? null, takes: takesLite,
      // What the animate console would submit right now, already resolved —
      // a tool reports the image it used instead of guessing.
      genSource: sub === "restyle" ? restyleSource : motionPlate,
    }),
    setTab, setSub, setKindFilter,
    selectTake: setSel,
    setGenField: (_s: GenSub, field: GenField, value: unknown) =>
      setGen((g: any) => ({ ...g, [field]: value })),
    submitGenerate: (s: GenSub) => submitBySub(s),
    setLive: (seconds: number) => setGen((g: any) => ({ ...g, live: seconds })),
    submitFreeze: () => submitFreeze(),
    submitTrim: (endSeconds: number) => submitTrim(endSeconds),
    setVoField: (field: VoField, value: unknown) =>
      setGen((g: any) => ({ ...g, [field]: value })),
    submitVo: () => submitVo(),
    setCueField: (kind: CueKind, field: CueField, value: unknown) =>
      setCue((c: any) => ({ ...c, [kind]: { ...c[kind], [field]: value } })),
    submitMusic: () => submitMusic(),
    submitSfx: () => submitSfx(),
    addCue,
    removeCue,
    addReference,
    removeReference,
    references: () => references,
    setKeeper: (path: string, note?: string) => setKeeperPath(path, note),
    setSource: (path: string | null) => setOverride({ source: path }),
    setOverride,
    direct: directHandle,
    applyPlan: applyPlanHandle,
    refresh: async () => { refresh(); refreshCues(); },
  });

  if (!shot) return <div className="muted">loading…</div>;

  const takeActions = (path: string) => (
    <div className="row" style={{ gap: 4 }}>
      {/\.(png|jpg|jpeg|webp)$/i.test(path) && (
        <button className="small"
          title="curation keeper — the plate animate, restyle and comps start from"
          data-action={ANCHORS.takeKeeper} data-path={path}
          onClick={() => fire(setKeeperPath(path))}>★ keeper</button>
      )}
      {/* A comp stages on a still plate OR on a clip — a moving background
          under moving cels is a legal composition. */}
      <button className="small"
        title={IS_CLIP(path) ? "stage a comp on this clip (moving background)"
                             : "stage a comp on this plate"}
        data-action={ANCHORS.takeCompose} data-path={path}
        onClick={() => run(() => api(`/api/projects/${pid}/comps`,
          { shot: sid, background: path, duration: shot.seconds }),
          (c: any) => { setActiveComp(c.cid); setTab("compose"); refresh(); })}>
        🎬 compose on this</button>
      {IS_CLIP(path) && (
        <button className="small" title="the held-cel edit"
          data-action={ANCHORS.takeFreeze} data-path={path}
          onClick={() => { setQ({ take: path, tab: "motion" }); }}>
          ❄ freeze…</button>
      )}
      {path !== shot.active_source && (
        <button className="small"
          data-action={ANCHORS.takeSource} data-path={path}
          onClick={() => fire(takeAction(`⬆ plays — ${path.split("/").pop()}`,
                                         setOverride({ source: path })))}>
          ⬆ timeline source</button>
      )}
      <button className="small"
        data-action={ANCHORS.takeScreen} data-path={path}
        title="Open in the screening room (Esc closes)"
        onClick={() => screen.open(path, { pid, seconds: shot.seconds })}>
        ⛶ screen</button>
    </div>
  );

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          <Link to={filmPath(pid)} title="back to Film Editor">🎞←</Link>{" "}
          <b>{sid}</b>
          <span className="muted"> · {shot.type} · {shot.register} ·
            {" "}{shot.seconds}s</span>
        </h2>
        <div className="row">
          {watchJob && <span className="chip">
            <span className="dot busy" /> working…</span>}
          <Link to={`${chatPath(pid)}?shot=${sid}`}>
            <button>💬 direct in chat</button></Link>
        </div>
      </div>

      <div className="split" style={{ marginTop: 12 }}>
        {/* ---------------------------------------------- monitor + takes */}
        <div className="col">
          <ShotMonitor pid={pid} sid={sid} rel={selected}
                       seconds={Number(shot.override?.seconds ?? shot.seconds) || 0} />
          <div className="row muted small">
            <code style={{ flex: 1, overflow: "hidden" }}>{selected}</code>
            {selected && selected === shot.active_source &&
              <span className="badge motion">playing in timeline</span>}
          </div>

          <div className="section">
            <div className="head">✨ Direct this shot</div>
            <div className="body col">
              <div className="row">
                <input style={{ flex: 1 }} value={instruction}
                       data-action={ANCHORS.directInput}
                       placeholder={'"keep the first second, freeze the rest"…'}
                       onChange={(e) => setInstruction(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && direct()} />
                <button className="primary" disabled={busy || !instruction}
                        data-action={ANCHORS.directSubmit}
                        onClick={direct}>compile</button>
              </div>
              {error && <div className="error">{error}</div>}
              {plan && <PlanPreview pid={pid} plan={plan.plan}
                                    source={plan.source}
                                    onApplied={(rs) => {
                                      setPlan(null);
                                      const j = rs.find((r: any) => r.job)?.job;
                                      if (j) setWatchJob(j);
                                      refresh();
                                    }} />}
            </div>
          </div>

          <div className="row">
            {KIND_FILTERS.map((k) => (
              <button key={k} className={`small ${kindFilter === k ? "primary" : ""}`}
                      data-action={ANCHORS.takesFilter} data-kind={k}
                      onClick={() => setKindFilter(k)}>{k}</button>
            ))}
            <span className="muted small">{gallery.length} takes</span>
          </div>
          <div className="takes">
            {gallery.map(({ path, kind }) => (
              <div key={path}
                   className={`take ${selected === path ? "selected" : ""} ` +
                              `${shot.keeper === path ? "keeper" : ""}`}
                   data-action={ANCHORS.shotTake} data-path={path} data-kind={kind}
                   onClick={() => setSel(path)}>
                <img src={thumbUrl(pid, path)} alt={path} loading="lazy" />
                <span className="tag">{kind} · {path.split("/").pop()}</span>
              </div>
            ))}
          </div>
          {selected && takeActions(selected)}
          {takeNote && (
            <div className={takeNote.bad ? "error" : "muted small"}>
              {takeNote.text}</div>)}
        </div>

        {/* -------------------------------------------------- workspace */}
        <div className="col">
          <div className="tabs">
            {WORK_TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "active" : ""}
                      data-action={shotTabAnchor(t.id)}
                      onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {tab === "compose" && <div className="col">
            <div className="muted small">
              A comp = the plate + z-ordered animated cel layers. The plate
              never shimmers; layers reroll independently.
            </div>
            <div className="row">
              {(shot.comps || []).map((c) => (
                <button key={c.cid}
                        className={activeComp === c.cid ? "primary" : ""}
                        data-action={ANCHORS.compPick} data-cid={c.cid}
                        onClick={() => setActiveComp(c.cid)}>
                  {c.cid} ({c.layers.length})</button>
              ))}
              <button disabled={!plate} data-action={ANCHORS.compCreate}
                onClick={() =>
                run(() => api(`/api/projects/${pid}/comps`,
                              { shot: sid, background: plate,
                                duration: shot.seconds }),
                    (c: any) => { setActiveComp(c.cid); refresh(); })}>
                + new comp from plate</button>
              <button disabled={!plate || !plateDims}
                      className={separating ? "primary" : ""}
                      data-action={ANCHORS.compSeparate}
                      onClick={() => setSeparating(!separating)}>
                ✂ separate figure</button>
            </div>
            {separating && plate && plateDims && (
              <SeparateCanvas pid={pid} sid={sid} plate={plate}
                plateW={plateDims[0]} plateH={plateDims[1]}
                seconds={shot.seconds}
                onDone={(comp) => { setSeparating(false);
                                    setActiveComp(comp); refresh(); }} />
            )}
            {(activeComp || shot.comps?.[0]?.cid) ? (
              <CompEditor pid={pid} cid={activeComp || shot.comps![0].cid}
                          onChanged={refresh} />
            ) : <div className="muted">no comps yet — stage one from the
              plate or any still (🎬 on a take)</div>}
          </div>}

          {tab === "generate" && <div className="col">
            {/* References: the pictures this shot must match. The server puts
                each one in front of the prompt behind a sentence naming its
                role, so a face is matched and a room is matched — a bare
                image would just be copied. Four per shot. */}
            <div className="section" data-action={ANCHORS.genRefs}>
              <div className="head">🖼 References
                <span className="muted small"> · sent with every still and
                  restyle of this shot</span></div>
              <div className="body col">
                <div className="takes">
                  {references.map((r) => (
                    <div key={r.path} className="take"
                         data-action={ANCHORS.genRef} data-path={r.path}
                         data-role={r.role} title={r.note || r.path}
                         onClick={() => setSel(r.path)}>
                      <img src={thumbUrl(pid, r.path)} alt={r.path} loading="lazy" />
                      <span className="tag">{r.role} · {r.path.split("/").pop()}</span>
                      <button className="small"
                              data-action={ANCHORS.genRefRemove} data-path={r.path}
                              title="stop matching this picture"
                              onClick={(e) => { e.stopPropagation();
                                                fire(removeReference(r.path)); }}>
                        ✕</button>
                    </div>
                  ))}
                  {!references.length &&
                    <div className="muted small">none — a reference pins a face,
                      a prop or a room to one picture.</div>}
                </div>
                <div className="row">
                  <select value={refPick.path} data-action={ANCHORS.genRefPick}
                          onChange={(e) => setRefPick({ ...refPick,
                                                        path: e.target.value })}>
                    <option value="">add from takes…</option>
                    {takesLite.filter((t) => IS_STILL(t.path)).map((t) => (
                      <option key={t.path} value={t.path}>
                        {t.kind} · {t.path.split("/").pop()}</option>
                    ))}
                  </select>
                  <select value={refPick.role} data-action={ANCHORS.genRefRole}
                          onChange={(e) => setRefPick({ ...refPick,
                            role: e.target.value as RefRole })}>
                    {REF_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button className="small" disabled={!refPick.path ||
                            references.length >= 4}
                          data-action={ANCHORS.genRefAdd}
                          onClick={() => { fire(addReference(
                            { path: refPick.path, role: refPick.role }));
                            setRefPick({ ...refPick, path: "" }); }}>
                    + add</button>
                  {references.length >= 4 &&
                    <span className="muted small">four is the limit</span>}
                </div>
              </div>
            </div>
            <div className="tabs">
              {GEN_SUBS.map((t) => (
                <button key={t} className={sub === t ? "active" : ""}
                        data-action={genSubAnchor(t)}
                        onClick={() => setSub(t)}>{t}
                </button>
              ))}
            </div>
            {sub === "still" && <div className="col">
              <ModelPicker pid={pid} lane="still" backend={gen.backend}
                model={gen.model}
                onChange={(b, m) => setGen({ ...gen, backend: b, model: m })} />
              <label className="field">prompt
                <textarea value={gen.prompt || shot.image_prompt}
                          data-action={genFieldAnchor("still", "prompt")}
                          onChange={(e) =>
                            setGen({ ...gen, prompt: e.target.value })} />
              </label>
              <div className="row">
                <label className="field">seeds
                  <input style={{ width: 110 }} placeholder="random"
                         data-action={genFieldAnchor("still", "seeds")}
                         value={gen.seeds} onChange={(e) =>
                           setGen({ ...gen, seeds: e.target.value })} /></label>
                <button className="primary" disabled={busy}
                  data-action={genFieldAnchor("still", "submit")}
                  onClick={() => fire(genStill())}>
                  ▶ generate still</button>
              </div>
            </div>}
            {sub === "restyle" && <div className="col">
              <ModelPicker pid={pid} lane="i2i" backend={gen.backend}
                model={gen.model}
                onChange={(b, m) => setGen({ ...gen, backend: b, model: m })} />
              <div className="muted small">source ={" "}
                <code>{restyleSource?.split("/").pop() ?? "select a take"}</code>
                {" "}· 0.55 keeps layout · 0.85 restyles.</div>
              <label className="field">prompt
                <textarea value={gen.prompt}
                          data-action={genFieldAnchor("restyle", "prompt")}
                          onChange={(e) =>
                            setGen({ ...gen, prompt: e.target.value })} /></label>
              <div className="row">
                <label className="field">denoise {gen.denoise}
                  <input type="range" min="0.35" max="0.95" step="0.05"
                         data-action={genFieldAnchor("restyle", "denoise")}
                         value={gen.denoise} onChange={(e) => setGen(
                           { ...gen, denoise: Number(e.target.value) })} />
                </label>
                <button className="primary"
                  disabled={busy || !selected || !gen.prompt}
                  data-action={genFieldAnchor("restyle", "submit")}
                  onClick={() => fire(genRestyle())}>
                  ▶ restyle selected</button>
              </div>
            </div>}
            {sub === "animate" && <div className="col">
              <ModelPicker pid={pid} lane="motion" backend={gen.backend}
                model={gen.model}
                onChange={(b, m) => setGen({ ...gen, backend: b, model: m })} />
              {/* WHICH IMAGE this animates. Motion has always started from the
                  keeper; the strip's yellow outline is only the monitor, so
                  "animate the one I am looking at" needs saying out loud. */}
              <div className="row">
                <label className="field">animate from
                  <select value={genSourcePick}
                          data-action={genFieldAnchor("animate", "source")}
                          onChange={(e) =>
                            setGen({ ...gen, source: e.target.value })}>
                    <option value="keeper">★ keeper (the plate)</option>
                    <option value="selected">selected take</option>
                    {genSourcePick === "take" &&
                      <option value={genSourceWord}>
                        {genSourceWord.split("/").pop()}</option>}
                  </select></label>
                <code className="muted small" style={{ overflow: "hidden" }}>
                  {motionPlate ?? "—"}</code>
                {/* No anchor here on purpose: `shot.take.keeper` belongs to the
                    rail's own ★ keeper button, and an agent pulse must land on
                    exactly one control. */}
                {motionPlate && motionPlate !== plate &&
                  <button className="small" title="make this still the shot's plate"
                          onClick={() => fire(setKeeperPath(motionPlate))}>
                    ★ keep it</button>}
              </div>
              {motionPlate && motionPlateDims ? <>
                <div className="row">
                  <label className="field">mode
                    <select value={gen.fullFrame ? "full" : "cel"}
                            data-action={genFieldAnchor("animate", "fullFrame")}
                            onChange={(e) => setGen({ ...gen,
                              fullFrame: e.target.value === "full" })}>
                      <option value="cel">cel region (draw on the plate)</option>
                      <option value="full">full frame</option>
                    </select></label>
                  <span className="muted small">plate {motionPlateDims[0]}×
                    {motionPlateDims[1]} — untouched outside the region</span>
                </div>
                {!gen.fullFrame && (
                  <div data-action={genFieldAnchor("animate", "region")}>
                    <RegionCanvas pid={pid} plate={motionPlate}
                      plateW={motionPlateDims[0]} plateH={motionPlateDims[1]}
                      region={gen.region}
                      onRegion={(r) => setGen({ ...gen, region: r })} />
                  </div>
                )}
                <label className="field">motion prompt (name only what moves)
                  <textarea value={gen.prompt || shot.motion_prompt || ""}
                            data-action={genFieldAnchor("animate", "prompt")}
                            onChange={(e) =>
                              setGen({ ...gen, prompt: e.target.value })} />
                </label>
                <div className="row">
                  <label className="field">seconds
                    <input style={{ width: 56 }} value={gen.seconds}
                           data-action={genFieldAnchor("animate", "seconds")}
                           onChange={(e) =>
                             setGen({ ...gen, seconds: e.target.value })} /></label>
                  <label className="field">frames
                    <input style={{ width: 64 }} value={gen.frames} placeholder="auto"
                           data-action={genFieldAnchor("animate", "frames")}
                           onChange={(e) =>
                             setGen({ ...gen, frames: e.target.value })} /></label>
                  <label className="field">steps
                    <input style={{ width: 56 }} placeholder="8"
                           data-action={genFieldAnchor("animate", "steps")}
                           value={gen.steps} onChange={(e) =>
                             setGen({ ...gen, steps: e.target.value })} /></label>
                  <label className="field">cfg
                    <input style={{ width: 56 }} placeholder="1.0"
                           data-action={genFieldAnchor("animate", "cfg")}
                           value={gen.cfg} onChange={(e) =>
                             setGen({ ...gen, cfg: e.target.value })} /></label>
                  <label className="field">freeze after (s)
                    <input style={{ width: 70 }} placeholder="off"
                           data-action={genFieldAnchor("animate", "freeze_after")}
                           value={gen.freeze_after} onChange={(e) =>
                             setGen({ ...gen, freeze_after: e.target.value })} />
                  </label>
                </div>
                {/* Progressive disclosure, human side: the models read an
                    anime plate as a photograph and fill the gap with photoreal
                    faces and daylight. Offered as a button, never appended
                    behind the director's back. */}
                {!saysAnime(gen.prompt || shot.motion_prompt || "") && (
                  <div className="row muted small">
                    <span style={{ flex: 1 }}>Nothing here says anime — i2v
                      models add photoreal people and daylight to a plate like
                      this.</span>
                    <button className="small"
                      onClick={() => setGen({ ...gen, prompt: withAnimeClause(
                        String(gen.prompt || shot.motion_prompt || "")).prompt })}>
                      ＋ {ANIME_CLAUSE}</button>
                  </div>
                )}
                <div className="muted small">hold 97f/8st/cfg1 · gesture
                  97f/12st/cfg2 · environment 25f/16st/cfg3 · first-second
                  49f + freeze 1s</div>
                <button className="primary" disabled={busy ||
                    (!gen.fullFrame && !gen.region) ||
                    !(gen.prompt || shot.motion_prompt)}
                  data-action={genFieldAnchor("animate", "submit")}
                  onClick={() => fire(genAnimate())}>
                  ▶ animate</button>
              </> : <div className="muted">{motionPlateWhy}</div>}
            </div>}
            {sub === "chain" && <div className="col">
              <div className="muted small">Breath-stitching: front-load each
                beat (≤1.2s live), end in a holdable pose; 0.3–0.6s breaths.
              </div>
              <label className="field">beats (JSON)
                <textarea className="mono" rows={6} value={gen.beats}
                          data-action={genFieldAnchor("chain", "beats")}
                          onChange={(e) =>
                            setGen({ ...gen, beats: e.target.value })} />
              </label>
              <div className="muted small">chains from {motionPlate
                ? motionPlate.split("/").pop() : motionPlateWhy} — the animate
                tab's "animate from" picks it.</div>
              <button className="primary" disabled={busy || !motionPlate}
                data-action={genFieldAnchor("chain", "submit")}
                onClick={() => fire(genChain())}>▶ chain</button>
            </div>}
          </div>}

          {tab === "motion" && <div className="col">
            <div className="muted small">
              The FIRST-SECOND LAW toolkit, on the selected clip:
              <code style={{ marginLeft: 6 }}>{IS_CLIP(selected) ? selected
                : "select a clip in the takes rail"}</code>
            </div>
            <div className="row">
              <label className="field">keep first (s)
                <input style={{ width: 76 }} type="number" step="0.1"
                       data-action={ANCHORS.motionLive}
                       value={gen.live} onChange={(e) =>
                         setGen({ ...gen, live: Number(e.target.value) })} />
              </label>
              <button className="primary" disabled={busy || !IS_CLIP(selected)}
                data-action={ANCHORS.motionFreeze}
                onClick={() => fire(submitFreeze())}>
                ❄ freeze tail (true freeze)</button>
              <button disabled={busy || !IS_CLIP(selected)}
                data-action={ANCHORS.motionTrim}
                onClick={() => fire(submitTrim(gen.live))}>
                ✂ keep only first {gen.live}s</button>
            </div>
            <div className="muted small">Or say it: “keep the first second and
              hold his pose for the rest of the line” in the direct box —
              it reads the real VO duration.</div>
          </div>}

          {tab === "audio" && <div className="col">
            <div data-action={ANCHORS.audioVoice}>
              <ModelPicker pid={pid} lane="vo" backend={gen.backend}
                model={gen.voice}
                onChange={(b, v) => setGen({ ...gen, backend: b, voice: v })} />
            </div>
            <label className="field">line (v3 tags pass through)
              <textarea value={gen.text || shot.narration || ""}
                        data-action={ANCHORS.audioText}
                        onChange={(e) =>
                          setGen({ ...gen, text: e.target.value })} /></label>
            <div className="row">
              <label className="field">treatment
                <select value={gen.treatment}
                        data-action={ANCHORS.audioTreatment}
                        title="what the line is heard through — none keeps it clean"
                        onChange={(e) =>
                          setGen({ ...gen, treatment: e.target.value })}>
                  {VO_TREATMENTS.map((name) => (
                    <option key={name} value={name}>{name}</option>))}
                </select></label>
              <button className="primary"
                disabled={busy || !(gen.text || shot.narration)}
                data-action={ANCHORS.audioSubmit}
                onClick={() => fire(submitVo())}>
                ▶ synthesize</button>
            </div>
            <div className="row muted small">
              <span>timing:</span>
              <label className="field">VO offset
                <input type="number" step="0.1" style={{ width: 70 }}
                       data-action={ANCHORS.audioVoOffset}
                       defaultValue={shot.override.vo_offset || 0}
                       onBlur={(e) => fire(setOverride(
                         { vo_offset: parseFloat(e.target.value) }))} /></label>
              <label className="field">mute
                <input type="checkbox" data-action={ANCHORS.audioMute}
                       defaultChecked={!!shot.override.mute_vo}
                       onChange={(e) => fire(setOverride(
                         { mute_vo: e.target.checked || null }))} /></label>
            </div>
            {shot.vo.map((v) => (
              <div className="row" key={v}>
                <button className="small" onClick={() => setSel(v)}>▶</button>
                <code className="small" style={{ flex: 1 }}>{v}</code>
                <button className="small"
                  data-action={ANCHORS.takeSource} data-path={v}
                  onClick={() => fire(setOverride({ vo_file: v }))}>
                  use in timeline</button>
              </div>
            ))}

            {/* ------------------------------------------ music & SFX */}
            <hr style={{ width: "100%", borderColor: "var(--line)",
                         opacity: 0.4 }} />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>Music &amp; SFX</b>
              <span className="muted small">generated audio is placed as a
                cue — music at this shot, SFX pinned to it</span>
            </div>
            <label className="field">music
              <textarea rows={2} placeholder="slow upright bass and brushed snare, elegiac"
                        data-action={ANCHORS.musicPrompt}
                        value={cue.music.prompt}
                        onChange={(e) => setCue({ ...cue,
                          music: { ...cue.music, prompt: e.target.value } })} />
            </label>
            <div className="row">
              <label className="field">seconds
                <input type="number" min={5} max={120} step={5} style={{ width: 76 }}
                       data-action={ANCHORS.musicSeconds}
                       value={cue.music.seconds}
                       onChange={(e) => setCue({ ...cue,
                         music: { ...cue.music, seconds: e.target.value } })} /></label>
              <label className="field">instrumental
                <input type="checkbox" data-action={ANCHORS.musicInstrumental}
                       title="no vocals — the right default under dialogue"
                       checked={!!cue.music.instrumental}
                       onChange={(e) => setCue({ ...cue,
                         music: { ...cue.music, instrumental: e.target.checked } })} /></label>
              <button className="primary" disabled={busy || !cue.music.prompt}
                data-action={ANCHORS.musicSubmit}
                onClick={() => fire(submitMusic())}>▶ music</button>
            </div>
            <label className="field">sfx
              <textarea rows={2} placeholder="chalk scraping on brick, close, dry room"
                        data-action={ANCHORS.sfxPrompt}
                        value={cue.sfx.prompt}
                        onChange={(e) => setCue({ ...cue,
                          sfx: { ...cue.sfx, prompt: e.target.value } })} />
            </label>
            <div className="row">
              <label className="field">seconds
                <input type="number" min={1} max={10} step={0.5} style={{ width: 76 }}
                       data-action={ANCHORS.sfxSeconds}
                       value={cue.sfx.seconds}
                       onChange={(e) => setCue({ ...cue,
                         sfx: { ...cue.sfx, seconds: e.target.value } })} /></label>
              <button className="primary" disabled={busy || !cue.sfx.prompt}
                data-action={ANCHORS.sfxSubmit}
                onClick={() => fire(submitSfx())}>▶ sfx</button>
            </div>
            <div className="col" data-action={ANCHORS.shotCues}>
              <div className="muted small">cues on {sid} — gain is dB, 0 is
                unity:</div>
              {shotCues.map((c) => (
                <div className="row" key={c.id}>
                  <span className="badge cel">{c.kind}</span>
                  <button className="small" onClick={() => setSel(c.path)}>▶</button>
                  <code className="small" style={{ flex: 1 }}>
                    {c.path.split("/").pop()}</code>
                  <span className="muted small">
                    +{c.offset || 0}s · {c.gain}dB
                    {c.exists === false ? " · missing" : ""}</span>
                  <button className="small" title="remove this cue"
                    data-action={ANCHORS.shotCueRemove} data-id={c.id}
                    onClick={() => fire(removeCue(c.id))}>✕</button>
                </div>
              ))}
              {shotCues.length === 0 && (
                <div className="muted small">none yet</div>)}
            </div>
          </div>}

          {tab === "script" && <div className="col small"
                                    data-action={ANCHORS.scriptPanel}>
            <div className="muted">
              {[shot.beat, shot.act ? `act ${shot.act}` : "", shot.type,
                shot.seconds ? `${shot.seconds}s` : ""]
                .filter(Boolean).join(" · ")}</div>
            {shot.register && <div className="muted">register: {shot.register}</div>}
            <label className="field">image prompt
              <textarea readOnly value={shot.image_prompt} /></label>
            {shot.negative && <label className="field">negative
              <textarea readOnly value={shot.negative} /></label>}
            {shot.motion_prompt && <label className="field">motion prompt
              <textarea readOnly value={shot.motion_prompt} /></label>}
            {shot.pan && <div className="muted">pan: {shot.pan}</div>}
            {shot.narration && (
              <div><b>narration:</b> {shot.narration}</div>)}
            {shot.dialogue?.map((d, i) => (
              <div key={i}><b>{d.character}:</b> {d.line}</div>
            ))}
            {shot.sfx && <div className="muted">sfx: {shot.sfx}</div>}
            {shot.ambient && <div className="muted">ambient: {shot.ambient}</div>}
            {shot.cut && <div className="muted">cut: {shot.cut}</div>}
            {shot.render_notes && (
              <div className="muted">notes: {shot.render_notes}</div>)}
            {shot.curation_note && (
              <div className="muted">curation: {shot.curation_note}</div>)}
          </div>}
        </div>
      </div>
    </div>
  );
}
