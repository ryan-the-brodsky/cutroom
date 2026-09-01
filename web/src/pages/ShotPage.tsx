import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import CompEditor from "../components/CompEditor";
import ModelPicker from "../components/ModelPicker";
import Player from "../components/Player";
import PlanPreview from "../components/PlanPreview";
import RegionCanvas from "../components/RegionCanvas";
import SeparateCanvas from "../components/SeparateCanvas";
import { pushToast, useAsync, useJobWatch, usePlateDims, usePoll } from "../hooks";
import type { FilmEntry, Plan, Take } from "../types";

/** SHOT EDITOR — granular, single-shot composition & editing. The Film
 * Editor arranges; this room is where one shot gets built. */

const WORK_TABS = ["compose", "generate", "motion edits", "audio", "script"];
const KIND_FILTERS = ["all", "stills", "i2i", "motion", "fx", "crops"];
const IS_CLIP = (p: string | null) => !!p && /\.(mp4|webm|mov)$/i.test(p);

export default function ShotPage() {
  const { pid, sid } = useParams() as { pid: string; sid: string };
  const { data: shot, refresh } =
    usePoll<FilmEntry>(`/api/projects/${pid}/shots/${sid}`, 0);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState("compose");
  const [kindFilter, setKindFilter] = useState("all");
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

  if (!shot) return <div className="muted">loading…</div>;

  const submitGen = (lane: string, body: any) =>
    run(() => api(`/api/projects/${pid}/generate/${lane}`,
                  { shot: sid, ...body }),
        (d: any) => { pushToast({ text: `${lane} queued`, job: d.job });
                      setWatchJob(d.job); });

  const direct = () => run(
    () => api(`/api/projects/${pid}/direct`,
              { instruction, shot: sid, asset: selected || undefined }),
    (d: any) => setPlan({ plan: d.plan, source: d.source }));

  const numOr = (v: any, d?: number) =>
    v === "" || v === null || v === undefined ? d : Number(v);

  const takeActions = (path: string) => (
    <div className="row" style={{ gap: 4 }}>
      {/\.(png|jpg|jpeg|webp)$/i.test(path) && <>
        <button className="small" title="curation keeper (the plate)"
          onClick={() => api(`/api/projects/${pid}/shots/${sid}/curate`,
                             { keeper: path }).then(refresh)}>★ keeper</button>
        <button className="small" title="stage a comp on this plate"
          onClick={() => run(() => api(`/api/projects/${pid}/comps`,
            { shot: sid, background: path, duration: shot.seconds }),
            (c: any) => { setActiveComp(c.cid); setTab("compose"); refresh(); })}>
          🎬 compose on this</button>
      </>}
      {IS_CLIP(path) && (
        <button className="small" title="the held-cel edit"
          onClick={() => { setSel(path); setTab("motion edits"); }}>
          ❄ freeze…</button>
      )}
      {path !== shot.active_source && (
        <button className="small"
          onClick={() => api(`/api/projects/${pid}/shots/${sid}/override`,
                             { source: path }).then(refresh)}>
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
                       placeholder={'"keep the first second, freeze the rest"…'}
                       onChange={(e) => setInstruction(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && direct()} />
                <button className="primary" disabled={busy || !instruction}
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
                      onClick={() => setKindFilter(k)}>{k}</button>
            ))}
            <span className="muted small">{gallery.length} takes</span>
          </div>
          <div className="takes">
            {gallery.map(({ path, kind }) => (
              <div key={path}
                   className={`take ${selected === path ? "selected" : ""} ` +
                              `${shot.keeper === path ? "keeper" : ""}`}
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
              <button key={t} className={tab === t ? "active" : ""}
                      onClick={() => setTab(t)}>{t}</button>
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
              {["still", "restyle", "animate", "chain"].map((t) => (
                <button key={t}
                        className={gen.subtab === t || (!gen.subtab && t === "still")
                          ? "active" : ""}
                        onClick={() => setGen({ ...gen, subtab: t })}>{t}
                </button>
              ))}
            </div>
            {(!gen.subtab || gen.subtab === "still") && <div className="col">
              <ModelPicker pid={pid} lane="still" backend={gen.backend}
                model={gen.model}
                onChange={(b, m) => setGen({ ...gen, backend: b, model: m })} />
              <label className="field">prompt
                <textarea value={gen.prompt || shot.image_prompt}
                          onChange={(e) =>
                            setGen({ ...gen, prompt: e.target.value })} />
              </label>
              <div className="row">
                <label className="field">seeds
                  <input style={{ width: 110 }} placeholder="random"
                         value={gen.seeds} onChange={(e) =>
                           setGen({ ...gen, seeds: e.target.value })} /></label>
                <button className="primary" disabled={busy}
                  onClick={() => submitGen("still", {
                    prompt: gen.prompt || shot.image_prompt,
                    negative: shot.negative, name: sid,
                    backend: gen.backend || undefined,
                    model: gen.model || undefined,
                    seeds: gen.seeds ? gen.seeds.split(",").map(Number)
                                     : undefined })}>
                  ▶ generate still</button>
              </div>
            </div>}
            {gen.subtab === "restyle" && <div className="col">
              <ModelPicker pid={pid} lane="i2i" backend={gen.backend}
                model={gen.model}
                onChange={(b, m) => setGen({ ...gen, backend: b, model: m })} />
              <div className="muted small">source = selected take.
                0.55 keeps layout · 0.85 restyles.</div>
              <label className="field">prompt
                <textarea value={gen.prompt} onChange={(e) =>
                  setGen({ ...gen, prompt: e.target.value })} /></label>
              <div className="row">
                <label className="field">denoise {gen.denoise}
                  <input type="range" min="0.35" max="0.95" step="0.05"
                         value={gen.denoise} onChange={(e) => setGen(
                           { ...gen, denoise: Number(e.target.value) })} />
                </label>
                <button className="primary"
                  disabled={busy || !selected || !gen.prompt}
                  onClick={() => submitGen("i2i", {
                    source: selected, prompt: gen.prompt,
                    denoise: gen.denoise, name: `${sid}-i2i`,
                    backend: gen.backend || undefined,
                    model: gen.model || undefined })}>
                  ▶ restyle selected</button>
              </div>
            </div>}
            {gen.subtab === "animate" && <div className="col">
              <ModelPicker pid={pid} lane="motion" backend={gen.backend}
                model={gen.model}
                onChange={(b, m) => setGen({ ...gen, backend: b, model: m })} />
              {plate && plateDims ? <>
                <div className="row">
                  <label className="field">mode
                    <select value={gen.fullFrame ? "full" : "cel"}
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
                            onChange={(e) =>
                              setGen({ ...gen, prompt: e.target.value })} />
                </label>
                <div className="row">
                  <label className="field">frames
                    <input style={{ width: 64 }} value={gen.frames}
                           onChange={(e) =>
                             setGen({ ...gen, frames: e.target.value })} /></label>
                  <label className="field">steps
                    <input style={{ width: 56 }} placeholder="8"
                           value={gen.steps} onChange={(e) =>
                             setGen({ ...gen, steps: e.target.value })} /></label>
                  <label className="field">cfg
                    <input style={{ width: 56 }} placeholder="1.0"
                           value={gen.cfg} onChange={(e) =>
                             setGen({ ...gen, cfg: e.target.value })} /></label>
                  <label className="field">freeze after (s)
                    <input style={{ width: 70 }} placeholder="off"
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
                  onClick={() => submitGen("motion", {
                    plate, prompt: gen.prompt || shot.motion_prompt,
                    region: gen.fullFrame ? undefined : gen.region,
                    frames: numOr(gen.frames, 97),
                    steps: numOr(gen.steps), cfg: numOr(gen.cfg),
                    freeze_after: numOr(gen.freeze_after),
                    name: `${sid}-${gen.fullFrame ? "full" : "cel"}`,
                    backend: gen.backend || undefined,
                    model: gen.model || undefined })}>
                  ▶ animate</button>
              </> : <div className="muted">no plate — set a keeper first</div>}
            </div>}
            {gen.subtab === "chain" && <div className="col">
              <div className="muted small">Breath-stitching: front-load each
                beat (≤1.2s live), end in a holdable pose; 0.3–0.6s breaths.
              </div>
              <label className="field">beats (JSON)
                <textarea className="mono" rows={6} value={gen.beats}
                          onChange={(e) =>
                            setGen({ ...gen, beats: e.target.value })} />
              </label>
              <button className="primary" disabled={busy || !plate}
                onClick={() => {
                  let beats: any;
                  try { beats = JSON.parse(gen.beats); }
                  catch { setError("beats is not valid JSON"); return; }
                  submitGen("chain", { plate, beats, name: `${sid}-chain` });
                }}>▶ chain</button>
            </div>}
          </div>}

          {tab === "motion edits" && <div className="col">
            <div className="muted small">
              The FIRST-SECOND LAW toolkit, on the selected clip:
              <code style={{ marginLeft: 6 }}>{IS_CLIP(selected) ? selected
                : "select a clip in the takes rail"}</code>
            </div>
            <div className="row">
              <label className="field">keep first (s)
                <input style={{ width: 76 }} type="number" step="0.1"
                       value={gen.live} onChange={(e) =>
                         setGen({ ...gen, live: Number(e.target.value) })} />
              </label>
              <button className="primary" disabled={busy || !IS_CLIP(selected)}
                onClick={() => submitGen("freeze",
                  { source: selected, live: gen.live })}>
                ❄ freeze tail (true freeze)</button>
              <button disabled={busy || !IS_CLIP(selected)}
                onClick={() => submitGen("trim",
                  { source: selected, end: gen.live })}>
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
                        onChange={(e) =>
                          setGen({ ...gen, text: e.target.value })} /></label>
            <div className="row">
              <label className="field">radio futz
                <input type="checkbox" checked={gen.futz}
                       title="in-scene radio: bandpass + grit + static bed"
                       onChange={(e) =>
                         setGen({ ...gen, futz: e.target.checked })} /></label>
              <button className="primary"
                disabled={busy || !(gen.text || shot.radio)}
                onClick={() => submitGen("vo", {
                  text: gen.text || shot.radio,
                  voice: gen.voice || undefined,
                  backend: gen.backend || undefined,
                  futz: gen.futz, name: `${sid}_call` })}>
                ▶ synthesize</button>
            </div>
            <div className="row muted small">
              <span>timing:</span>
              <label className="field">VO offset
                <input type="number" step="0.1" style={{ width: 70 }}
                       defaultValue={shot.override.vo_offset || 0}
                       onBlur={(e) => api(
                         `/api/projects/${pid}/shots/${sid}/override`,
                         { vo_offset: parseFloat(e.target.value) })
                         .then(refresh)} /></label>
              <label className="field">mute
                <input type="checkbox" defaultChecked={!!shot.override.mute_vo}
                       onChange={(e) => api(
                         `/api/projects/${pid}/shots/${sid}/override`,
                         { mute_vo: e.target.checked || null })
                         .then(refresh)} /></label>
            </div>
            {shot.vo.map((v) => (
              <div className="row" key={v}>
                <button className="small" onClick={() => setSel(v)}>▶</button>
                <code className="small" style={{ flex: 1 }}>{v}</code>
                <button className="small" onClick={() => api(
                  `/api/projects/${pid}/shots/${sid}/override`,
                  { vo_file: v }).then(refresh)}>use in timeline</button>
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
