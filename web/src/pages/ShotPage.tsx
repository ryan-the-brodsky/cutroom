import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import {
  ANCHORS, genFieldAnchor, genSubAnchor, shotTabAnchor,
  type GenField, type GenSub, type KindFilter, type ShotTab, type TakeLite, type VoField,
} from "../agent/contract";
import { usePageHandles } from "../agent/pageHandles";
import { pick, useQueryState } from "../agent/urlState";
import CompEditor from "../components/CompEditor";
import ModelPicker from "../components/ModelPicker";
import Player from "../components/Player";
import PlanPreview from "../components/PlanPreview";
import RegionCanvas from "../components/RegionCanvas";
import SeparateCanvas from "../components/SeparateCanvas";
import { pushToast, useAsync, useJobWatch, usePlateDims, usePoll } from "../hooks";
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
  const [activeComp, setActiveComp] = useState<string | null>(null);
  const [separating, setSeparating] = useState(false);
  const { busy, error, run, setError } = useAsync();

  const [gen, setGen] = useState<any>({ backend: "", model: "", seeds: "",
    prompt: "", denoise: 0.85, frames: 97, steps: "", cfg: "", live: 1.0,
    freeze_after: "", region: null as number[] | null, fullFrame: false,
    voice: "", text: "", futz: false, beats:
      '[{"prompt": "", "live": 1.0, "breath": 0.4}]' });

  const selected = sel || shot?.active_source || null;
  const plate = shot?.keeper || shot?.stills[0] || null;
  const plateDims = usePlateDims(pid, plate);

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
    const d = await run(() => api<{ job: string; pool?: string }>(
      `/api/projects/${pid}/generate/${lane}`, { shot: sid, ...body }),
      (v: any) => { pushToast({ text: `${lane} queued`, job: v.job });
                    setWatchJob(v.job); });
    if (!d?.job) throw new Error(`${lane} did not queue — see the error above`);
    return d;
  };
  const fire = (p: Promise<unknown>) => { void p.catch(() => {}); };

  const genStill = () => submitGen("still", {
    prompt: gen.prompt || shot?.image_prompt,
    negative: shot?.negative, name: sid,
    backend: gen.backend || undefined, model: gen.model || undefined,
    seeds: gen.seeds ? String(gen.seeds).split(",").map(Number) : undefined });

  const genRestyle = () => submitGen("i2i", {
    source: selected, prompt: gen.prompt, denoise: gen.denoise,
    name: `${sid}-i2i`, backend: gen.backend || undefined,
    model: gen.model || undefined });

  const genAnimate = () => submitGen("motion", {
    plate, prompt: gen.prompt || shot?.motion_prompt,
    region: gen.fullFrame ? undefined : gen.region,
    frames: numOr(gen.frames, 97), steps: numOr(gen.steps), cfg: numOr(gen.cfg),
    freeze_after: numOr(gen.freeze_after),
    name: `${sid}-${gen.fullFrame ? "full" : "cel"}`,
    backend: gen.backend || undefined, model: gen.model || undefined });

  const genChain = () => {
    let beats: any;
    try { beats = JSON.parse(gen.beats); }
    catch { setError("beats is not valid JSON");
            return Promise.reject(new Error("beats is not valid JSON")); }
    return submitGen("chain", { plate, beats, name: `${sid}-chain` });
  };

  const submitBySub = (s: GenSub) => (
    s === "restyle" ? genRestyle() : s === "animate" ? genAnimate()
      : s === "chain" ? genChain() : genStill());

  const submitFreeze = () => submitGen("freeze", { source: selected, live: gen.live });
  const submitTrim = (end: number) => submitGen("trim", { source: selected, end });
  const submitVo = () => submitGen("vo", {
    text: gen.text || shot?.radio, voice: gen.voice || undefined,
    backend: gen.backend || undefined, futz: gen.futz, name: `${sid}_call` });

  const setOverride = (patch: Record<string, unknown>) =>
    api(`/api/projects/${pid}/shots/${sid}/override`, patch).then(() => refresh());
  const setKeeperPath = (path: string, note?: string) =>
    api(`/api/projects/${pid}/shots/${sid}/curate`,
        { keeper: path, ...(note ? { note } : {}) }).then(() => refresh());

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
    setKeeper: (path: string, note?: string) => setKeeperPath(path, note),
    setSource: (path: string | null) => setOverride({ source: path }),
    setOverride,
    direct: directHandle,
    applyPlan: applyPlanHandle,
    refresh: async () => { refresh(); },
  });

  if (!shot) return <div className="muted">loading…</div>;

  const takeActions = (path: string) => (
    <div className="row" style={{ gap: 4 }}>
      {/\.(png|jpg|jpeg|webp)$/i.test(path) && <>
        <button className="small" title="curation keeper (the plate)"
          data-action={ANCHORS.takeKeeper} data-path={path}
          onClick={() => fire(setKeeperPath(path))}>★ keeper</button>
        <button className="small" title="stage a comp on this plate"
          data-action={ANCHORS.takeCompose} data-path={path}
          onClick={() => run(() => api(`/api/projects/${pid}/comps`,
            { shot: sid, background: path, duration: shot.seconds }),
            (c: any) => { setActiveComp(c.cid); setTab("compose"); refresh(); })}>
          🎬 compose on this</button>
      </>}
      {IS_CLIP(path) && (
        <button className="small" title="the held-cel edit"
          data-action={ANCHORS.takeFreeze} data-path={path}
          onClick={() => { setQ({ take: path, tab: "motion" }); }}>
          ❄ freeze…</button>
      )}
      {path !== shot.active_source && (
        <button className="small"
          data-action={ANCHORS.takeSource} data-path={path}
          onClick={() => fire(setOverride({ source: path }))}>
          ⬆ timeline source</button>
      )}
    </div>
  );

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          <Link to={`/p/${pid}`} title="back to Film Editor">🎞←</Link>{" "}
          <b>{sid}</b>
          <span className="muted"> · {shot.type} · {shot.register} ·
            {" "}{shot.seconds}s</span>
        </h2>
        <div className="row">
          {watchJob && <span className="chip">
            <span className="dot busy" /> working…</span>}
          <Link to={`/p/${pid}/chat?shot=${sid}`}>
            <button>💬 direct in chat</button></Link>
        </div>
      </div>

      <div className="split" style={{ marginTop: 12 }}>
        {/* ---------------------------------------------- monitor + takes */}
        <div className="col">
          <Player pid={pid} rel={selected} />
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
                        onClick={() => setActiveComp(c.cid)}>
                  {c.cid} ({c.layers.length})</button>
              ))}
              <button disabled={!plate} onClick={() =>
                run(() => api(`/api/projects/${pid}/comps`,
                              { shot: sid, background: plate,
                                duration: shot.seconds }),
                    (c: any) => { setActiveComp(c.cid); refresh(); })}>
                + new comp from plate</button>
              <button disabled={!plate || !plateDims}
                      className={separating ? "primary" : ""}
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
              <div className="muted small">source = selected take.
                0.55 keeps layout · 0.85 restyles.</div>
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
              {plate && plateDims ? <>
                <div className="row">
                  <label className="field">mode
                    <select value={gen.fullFrame ? "full" : "cel"}
                            data-action={genFieldAnchor("animate", "fullFrame")}
                            onChange={(e) => setGen({ ...gen,
                              fullFrame: e.target.value === "full" })}>
                      <option value="cel">cel region (draw on the plate)</option>
                      <option value="full">full frame</option>
                    </select></label>
                  <span className="muted small">plate {plateDims[0]}×
                    {plateDims[1]} — untouched outside the region</span>
                </div>
                {!gen.fullFrame && (
                  <RegionCanvas pid={pid} plate={plate}
                    plateW={plateDims[0]} plateH={plateDims[1]}
                    region={gen.region}
                    onRegion={(r) => setGen({ ...gen, region: r })} />
                )}
                <label className="field">motion prompt (name only what moves)
                  <textarea value={gen.prompt || shot.motion_prompt || ""}
                            data-action={genFieldAnchor("animate", "prompt")}
                            onChange={(e) =>
                              setGen({ ...gen, prompt: e.target.value })} />
                </label>
                <div className="row">
                  <label className="field">frames
                    <input style={{ width: 64 }} value={gen.frames}
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
                <div className="muted small">hold 97f/8st/cfg1 · gesture
                  97f/12st/cfg2 · environment 25f/16st/cfg3 · first-second
                  49f + freeze 1s</div>
                <button className="primary" disabled={busy ||
                    (!gen.fullFrame && !gen.region) ||
                    !(gen.prompt || shot.motion_prompt)}
                  data-action={genFieldAnchor("animate", "submit")}
                  onClick={() => fire(genAnimate())}>
                  ▶ animate</button>
              </> : <div className="muted">no plate — set a keeper first</div>}
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
              <button className="primary" disabled={busy || !plate}
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
            <ModelPicker pid={pid} lane="vo" backend={gen.backend}
              model={gen.voice}
              onChange={(b, v) => setGen({ ...gen, backend: b, voice: v })} />
            <label className="field">line (v3 tags pass through)
              <textarea value={gen.text || shot.radio || ""}
                        data-action={ANCHORS.audioText}
                        onChange={(e) =>
                          setGen({ ...gen, text: e.target.value })} /></label>
            <div className="row">
              <label className="field">radio futz
                <input type="checkbox" checked={gen.futz}
                       data-action={ANCHORS.audioFutz}
                       title="in-scene radio: bandpass + grit + static bed"
                       onChange={(e) =>
                         setGen({ ...gen, futz: e.target.checked })} /></label>
              <button className="primary"
                disabled={busy || !(gen.text || shot.radio)}
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
          </div>}

          {tab === "script" && <div className="col small">
            <label className="field">image prompt
              <textarea readOnly value={shot.image_prompt} /></label>
            {shot.motion_prompt && <label className="field">motion prompt
              <textarea readOnly value={shot.motion_prompt} /></label>}
            {shot.pan && <div className="muted">pan: {shot.pan}</div>}
            {shot.radio && <div><b>radio:</b> {shot.radio}</div>}
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
