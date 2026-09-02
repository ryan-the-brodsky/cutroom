import { useEffect, useRef, useState } from "react";
import { api, mediaUrl, thumbUrl } from "../api";
import { ANCHORS, type BgField, type CompLayerLite } from "../agent/contract";
import { usePageHandles } from "../agent/pageHandles";
import ModelPicker from "./ModelPicker";
import Player from "./Player";
import RegionCanvas from "./RegionCanvas";
import Spotlight from "./Spotlight";
import { pushToast, useAsync, useJobWatch, usePlateDims, usePoll } from "../hooks";
import type { CompLayer, CompSummary, Take } from "../types";

const IS_CLIP = (p: string | null | undefined) =>
  !!p && /\.(mp4|webm|mov|mkv|m4v)$/i.test(p);

/** A media thumb: click = spotlight (or a custom action); active = amber. */
function Thumb({ pid, rel, size = 92, active = false, onClick, title, action, data }: {
  pid: string; rel: string; size?: number; active?: boolean;
  onClick: () => void; title?: string; action?: string;
  data?: Record<string, string>;
}) {
  return (
    <img src={thumbUrl(pid, rel, 240)} alt={rel} title={title || rel}
         onClick={onClick} loading="lazy"
         data-action={action} {...(data || {})}
         style={{ width: size, aspectRatio: "16/9", objectFit: "cover",
                  borderRadius: 5, cursor: "pointer", background: "#000",
                  border: active ? "2px solid var(--accent)"
                                 : "2px solid var(--line)" }} />
  );
}

/** The cel-composition workbench: stage (region drawing over the plate),
 * layers with independent rerolls, background restyle, render. Used inline
 * by the Shot Editor's Compose tab and by the standalone /comp route.
 *
 * It also registers `kind: "comp"` page handles (docs/WEBMCP-PLAN.md §3.3) so the
 * agent's cel tools drive the same handlers the buttons call — see
 * `web/src/agent/tools/comp.ts`. */
export default function CompEditor({ pid, cid, onChanged }: {
  pid: string; cid: string; onChanged?: () => void;
}) {
  const { data: comps, refresh } =
    usePoll<CompSummary[]>(`/api/projects/${pid}/comps`, 0);
  const comp = comps?.find((c) => c.cid === cid);
  const { data: renders, refresh: refreshRenders } = usePoll<Take[]>(
    `/api/projects/${pid}/takes?kind=comp&limit=10`, 0);
  const { busy, error, run } = useAsync();
  const [newRegion, setNewRegion] = useState<number[] | null>(null);
  const [newPrompt, setNewPrompt] = useState("");
  const [bgPrompt, setBgPrompt] = useState("");
  const [bgDenoise, setBgDenoise] = useState(0.55);
  const [bgMode, setBgMode] = useState<"edit" | "regen">("edit");
  const [watchJob, setWatchJob] = useState<string | null>(null);
  const [spot, setSpot] = useState<string | null>(null);
  const [selLayer, setSelLayer] = useState<string | null>(null);
  // per-layer reroll console: which layer is open + its working values
  const [rerollFor, setRerollFor] = useState<string | null>(null);
  const [reroll, setReroll] = useState<{ prompt: string; backend: string;
    model: string; seed: string }>({ prompt: "", backend: "", model: "",
                                     seed: "" });
  const plateDims = usePlateDims(pid, comp?.background || null);
  // A comp background is a still plate OR a clip: a still never shimmers (the
  // classic cel grammar, and the only thing restyle can touch); a clip lets a
  // moving background carry moving cels.
  const bgIsVideo = comp
    ? comp.background_kind === "video" || IS_CLIP(comp.background)
    : false;
  const undoStack = useRef<CompLayer[][]>([]);
  const renderTimer = useRef<any>(null);

  /** Debounced preview: edits persist immediately; the composite re-renders
   * 1.5s after the last change so a drag doesn't spawn a job per pixel. */
  const scheduleRender = () => {
    clearTimeout(renderTimer.current);
    renderTimer.current = setTimeout(async () => {
      try {
        const d = await api(`/api/projects/${pid}/comps/${cid}/render`, {});
        pushToast({ text: "re-rendering composition…", job: d.job });
        setWatchJob(d.job);
      } catch { /* surfaced by the jobs page */ }
    }, 1500);
  };

  const persistLayers = (layers: CompLayer[], render = true) =>
    run(async () => {
      undoStack.current.push(comp!.layers.map((l) => ({ ...l })));
      if (undoStack.current.length > 20) undoStack.current.shift();
      await api(`/api/projects/${pid}/comps/${cid}`, { layers });
      refresh();
      if (render) scheduleRender();
    });

  const changeLayer = (id: string, patch: Partial<CompLayer>) =>
    persistLayers(comp!.layers.map((x) =>
      x.id === id ? { ...x, ...patch } : x));

  // standard keyboard vocabulary: arrows nudge (shift = ×10),
  // delete removes, cmd/ctrl+Z undoes — unless you're typing somewhere.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || !comp) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        const prev = undoStack.current.pop();
        if (prev) {
          e.preventDefault();
          run(async () => {
            await api(`/api/projects/${pid}/comps/${cid}`, { layers: prev });
            refresh(); scheduleRender();
            pushToast({ text: "undo" });
          });
        }
        return;
      }
      if (!selLayer) return;
      const L = comp.layers.find((x) => x.id === selLayer);
      if (!L) return;
      const step = e.shiftKey ? 10 : 1;
      const [l, t, r, b] = L.region;
      const mv: Record<string, number[]> = {
        ArrowLeft: [l - step, t, r - step, b],
        ArrowRight: [l + step, t, r + step, b],
        ArrowUp: [l, t - step, r, b - step],
        ArrowDown: [l, t + step, r, b + step],
      };
      if (mv[e.key]) {
        e.preventDefault();
        changeLayer(selLayer, { region: mv[e.key] });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        persistLayers(comp.layers.filter((x) => x.id !== selLayer));
        setSelLayer(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  /** Switch a layer's active cel to one of its stored variants, then
   * re-render so the full composition shows the chosen option. */
  const activateVariant = (L: CompLayer, clip: string) =>
    run(async () => {
      const layers = comp!.layers.map((x) =>
        x.id === L.id ? { ...x, clip } : x);
      await api(`/api/projects/${pid}/comps/${cid}`, { layers });
      const d = await api(`/api/projects/${pid}/comps/${cid}/render`, {});
      pushToast({ text: `re-rendering with ${L.id} variant`, job: d.job });
      setWatchJob(d.job);
      refresh();
    });

  /** Switch the plate; server keeps every option in background_history. */
  const activateBackground = (rel: string) =>
    run(async () => {
      await api(`/api/projects/${pid}/comps/${cid}`, { background: rel });
      const d = await api(`/api/projects/${pid}/comps/${cid}/render`, {});
      pushToast({ text: "re-rendering with new background", job: d.job });
      setWatchJob(d.job);
      refresh();
    });

  useJobWatch(watchJob, (ok) => {
    setWatchJob(null);
    pushToast({ text: ok ? "comp job finished" : "comp job FAILED",
                job: watchJob || undefined });
    refresh(); refreshRenders(); onChanged?.();
  });

  const latestRender = (renders || []).find(
    (r) => r.params?.comp === cid || r.path.includes(`comp-${cid}`));

  // ------------------------------------------------------- the handlers (buttons AND agent)
  // Every handle below is the function a button calls, so an agent submission is the
  // submission a human makes. Kept above the `!comp` early return: hooks are unconditional.

  const addLayer = async (extra: Record<string, unknown> = {}) => {
    const d = await api<{ job: string; layer?: string }>(
      `/api/projects/${pid}/comps/${cid}/layers`,
      { region: newRegion, prompt: newPrompt, ...extra });
    pushToast({ text: "cel layer generating", job: d.job });
    if (d.job) setWatchJob(d.job);
    setNewRegion(null); setNewPrompt("");
    refresh();
    return d;
  };

  const rerollLayerHandle = async (id: string, opts: Record<string, unknown> = {}) => {
    const d = await api<{ job: string }>(
      `/api/projects/${pid}/comps/${cid}/layers/${id}/reroll`, opts);
    pushToast({ text: `rerolling ${id}`, job: d.job });
    if (d.job) setWatchJob(d.job);
    return d;
  };

  const submitBackgroundHandle = async () => {
    const d = await api<{ job: string }>(
      `/api/projects/${pid}/comps/${cid}/background/reroll`,
      { prompt: bgPrompt, denoise: bgDenoise, mode: bgMode });
    pushToast({ text: bgMode === "edit" ? "editing the plate…"
                                        : "regenerating the plate…", job: d.job });
    if (d.job) setWatchJob(d.job);
    return d;
  };

  const setDurationHandle = async (seconds: number) => {
    await api(`/api/projects/${pid}/comps/${cid}`, { duration: seconds });
    refresh();
  };

  const renderCompHandle = async () => {
    clearTimeout(renderTimer.current);        // an explicit render supersedes the debounce
    const d = await api<{ job: string }>(`/api/projects/${pid}/comps/${cid}/render`, {});
    pushToast({ text: "comp rendering", job: d.job });
    if (d.job) setWatchJob(d.job);
    return d;
  };

  const promoteHandle = async (path?: string) => {
    const rel = path || latestRender?.path;
    if (!rel) throw new Error("no rendered composite yet — render the comp first");
    if (!comp?.shot) throw new Error("this comp is not attached to a shot");
    await api(`/api/projects/${pid}/shots/${comp.shot}/override`, { source: rel });
    pushToast({ text: "comp → timeline source" });
    onChanged?.();
    return { path: rel };
  };

  const layersLite: CompLayerLite[] = (comp?.layers || []).map((L) => ({
    id: L.id, clip: L.clip ?? null, region: L.region, prompt: L.prompt,
    z: L.z, opacity: L.opacity, matte: L.matte,
    variants: (L.variants || []).filter((v) => v.clip).length,
    figure: Boolean(L.source_plate),
  }));

  usePageHandles({
    kind: "comp", pid, cid, sid: comp?.shot ?? null,
    getState: () => ({
      cid, shot: comp?.shot ?? null, background: comp?.background ?? "",
      backgroundKind: (bgIsVideo ? "video" : "still") as "still" | "video",
      duration: comp?.duration ?? 0, plate: plateDims,
      layers: layersLite, selected: selLayer,
      backgrounds: [comp?.background ?? "", ...(comp?.background_history || [])]
        .filter((v, i, a) => v && a.indexOf(v) === i),
      render: latestRender?.path ?? null,
    }),
    selectLayer: setSelLayer,
    setNewRegion,
    setNewPrompt,
    submitLayer: addLayer,
    patchLayer: async (id, patch) => {
      await persistLayers((comp?.layers || []).map((x) =>
        x.id === id ? { ...x, ...(patch as Partial<CompLayer>) } : x));
    },
    removeLayer: async (id) => {
      setSelLayer((s) => (s === id ? null : s));
      await persistLayers((comp?.layers || []).filter((x) => x.id !== id));
    },
    rerollLayer: rerollLayerHandle,
    setBackground: async (rel: string) => { await activateBackground(rel); },
    setBgField: (field: BgField, value: unknown) => {
      if (field === "prompt") setBgPrompt(String(value ?? ""));
      else if (field === "mode") setBgMode(value === "regen" ? "regen" : "edit");
      else setBgDenoise(Number(value));
    },
    submitBackground: submitBackgroundHandle,
    setDuration: setDurationHandle,
    renderComp: renderCompHandle,
    promote: promoteHandle,
    refresh: async () => { refresh(); refreshRenders(); },
  });

  if (!comp) return <div className="muted">loading comp…</div>;

  const submit = (path: string, body: any, label: string) =>
    run(() => api(path, body), (d: any) => {
      pushToast({ text: label, job: d.job });
      if (d.job) setWatchJob(d.job);
    });

  return (
    <div className="col">
      {error && <div className="error">{error}</div>}
      {watchJob && <div className="chip"><span className="dot busy" />
        working… (auto-refreshes)</div>}

      <b>Stage — draw a region to plan a new cel</b>
      {plateDims ? (
        <div data-action={ANCHORS.compStage} data-cid={cid}>
          <RegionCanvas
            pid={pid} plate={comp.background}
            plateW={plateDims[0]} plateH={plateDims[1]}
            region={newRegion} selected={selLayer}
            others={comp.layers.map((L) => ({ id: L.id, region: L.region }))}
            onRegion={setNewRegion}
            onSelect={setSelLayer}
            onLayerChange={(id, region) => changeLayer(id, { region })} />
        </div>
      ) : <div className="muted">measuring plate…</div>}
      <div className="muted small">
        {bgIsVideo ? "background clip" : "plate"}: <code>{comp.background}</code>
        {plateDims && <> · {plateDims[0]}×{plateDims[1]} px</>}
        {bgIsVideo && <> · <b>moving background</b> (regions are drawn over its
          first frame)</>} · drag a cel to
        move · corners resize · arrows nudge (⇧×10) · del removes · ⌘Z undo ·
        drag empty plate = new cel. Edits auto-preview after 1.5s.
      </div>
      {newRegion && (
        <div className="col card">
          <b>new cel @ [{newRegion.join(", ")}]</b>
          <label className="field">motion prompt (name only what moves)
            <textarea value={newPrompt} data-action={ANCHORS.compNewPrompt}
                      onChange={(e) => setNewPrompt(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" disabled={busy || !newPrompt}
              data-action={ANCHORS.compNewSubmit}
              onClick={() => run(() => addLayer())}>
              ▶ add layer & generate cel</button>
            <button data-action={ANCHORS.compNewCancel}
                    onClick={() => setNewRegion(null)}>cancel</button>
          </div>
        </div>
      )}

      <b>Layers ({comp.layers.length})</b>
      {comp.layers.map((L) => {
        const variants = (L.variants || []).filter((v) => v.clip);
        if (L.clip && !variants.some((v) => v.clip === L.clip)) {
          variants.unshift({ clip: L.clip, prompt: L.prompt });
        }
        return (
        <div className="card" key={L.id}
             data-action={ANCHORS.compLayer} data-id={L.id}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            {L.clip ? (
              <Thumb pid={pid} rel={L.clip} size={128}
                     title="click to spotlight this cel"
                     action={ANCHORS.compLayerSpotlight} data={{ "data-id": L.id }}
                     onClick={() => setSpot(L.clip)} />
            ) : (
              <div className="muted small" style={{ width: 128 }}>
                no cel yet</div>
            )}
            <div className="col" style={{ flex: 1, gap: 4 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b style={{ cursor: "pointer", color: selLayer === L.id
                            ? "var(--accent)" : undefined }}
                   data-action={ANCHORS.compLayerSelect} data-id={L.id}
                   onClick={() => setSelLayer(L.id)}>{L.id}</b>
                <span className="row muted small">
                  {L.source_plate && <span className="badge keeper"
                    title={`separated figure — cel animates from ${
                      L.source_plate}`}>✂ figure</span>}
                  [{L.region.map(Math.round).join(", ")}] ·
                  <select value={L.matte || "window"}
                          data-action={ANCHORS.compLayerMatte} data-id={L.id}
                          title="window = feathered rectangle; figure =
per-frame isnet-anime matte (only the figure lands on the plate)"
                          onChange={(e) => changeLayer(L.id,
                            { matte: e.target.value })}>
                    <option value="window">window</option>
                    <option value="figure">figure</option>
                  </select> · z{L.z}
                  <button className="small" title="bring forward"
                          data-action={ANCHORS.compLayerZ} data-id={L.id}
                          onClick={() => changeLayer(L.id,
                            { z: (L.z || 0) + 1 })}>▲</button>
                  <button className="small" title="send back"
                          data-action={`${ANCHORS.compLayerZ}.back`} data-id={L.id}
                          onClick={() => changeLayer(L.id,
                            { z: (L.z || 0) - 1 })}>▼</button>
                  <label className="field" title="opacity">
                    <input type="range" min="0.1" max="1" step="0.05"
                           style={{ width: 60 }}
                           data-action={ANCHORS.compLayerOpacity} data-id={L.id}
                           value={L.opacity ?? 1}
                           onChange={(e) => changeLayer(L.id,
                             { opacity: Number(e.target.value) })} />
                  </label>
                </span>
              </div>
              {L.prompt && <div className="small">{L.prompt}</div>}
              {variants.length > 1 && <>
                <div className="muted small">
                  {variants.length} stored takes — click to use in the comp,
                  ⛶ to spotlight:</div>
                <div className="row">
                  {variants.map((v) => (
                    <div key={v.clip} className="col" style={{ gap: 2 }}>
                      <Thumb pid={pid} rel={v.clip} size={72}
                             active={v.clip === L.clip}
                             title={v.prompt || v.clip}
                             action={ANCHORS.compLayerVariant}
                             data={{ "data-id": L.id, "data-path": v.clip }}
                             onClick={() => v.clip !== L.clip &&
                                            activateVariant(L, v.clip)} />
                      <button className="small" style={{ padding: "0 4px" }}
                              onClick={() => setSpot(v.clip)}>⛶</button>
                    </div>
                  ))}
                </div>
              </>}
            </div>
          </div>
          <div className="row">
            <button className="primary" disabled={busy}
              data-action={ANCHORS.compLayerReroll} data-id={L.id}
              title="same prompt, fresh seed — the take you compare against"
              onClick={() => run(() => rerollLayerHandle(L.id))}>
              🎲 reroll</button>
            <button disabled={busy}
              data-action={ANCHORS.compLayerDirected} data-id={L.id}
              className={rerollFor === L.id ? "primary" : ""}
              onClick={() => {
                setRerollFor(rerollFor === L.id ? null : L.id);
                setReroll({ prompt: L.prompt || "", backend: "", model: "",
                            seed: "" });
              }}>🎛 directed reroll…</button>
            <button className="danger" disabled={busy}
              data-action={ANCHORS.compLayerRemove} data-id={L.id}
              onClick={() => run(() => persistLayers(
                comp.layers.filter((x) => x.id !== L.id)))}>remove</button>
          </div>
          {rerollFor === L.id && (
            <div className="col card">
              <ModelPicker pid={pid} lane="motion" backend={reroll.backend}
                model={reroll.model}
                onChange={(b, m) => setReroll({ ...reroll, backend: b,
                                                model: m })} />
              <label className="field">motion prompt (name only what moves)
                <textarea value={reroll.prompt}
                  data-action={ANCHORS.compRerollPrompt} data-id={L.id}
                  onChange={(e) => setReroll({ ...reroll,
                                               prompt: e.target.value })} />
              </label>
              <div className="row">
                <label className="field">seed
                  <input style={{ width: 90 }} placeholder="random"
                    data-action={ANCHORS.compRerollSeed} data-id={L.id}
                    value={reroll.seed}
                    onChange={(e) => setReroll({ ...reroll,
                                                 seed: e.target.value })} />
                </label>
                <span style={{ flex: 1 }} />
                <button className="primary" disabled={busy || !reroll.prompt}
                  data-action={ANCHORS.compRerollSubmit} data-id={L.id}
                  onClick={() => submit(
                    `/api/projects/${pid}/comps/${cid}/layers/${L.id}/reroll`,
                    { prompt: reroll.prompt,
                      backend: reroll.backend || undefined,
                      model: reroll.model || undefined,
                      seed: reroll.seed ? Number(reroll.seed) : undefined },
                    `rerolling ${L.id} (directed)`)}>
                  ▶ reroll {L.id}</button>
              </div>
            </div>
          )}
        </div>
        );
      })}

      <b>Background {bgIsVideo && <span className="badge motion">clip</span>}</b>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {bgIsVideo ? (
          <video src={mediaUrl(pid, comp.background)} muted loop autoPlay
                 playsInline data-action={ANCHORS.compBgPlate}
                 data-path={comp.background}
                 title="the background clip — it plays under every cel"
                 style={{ width: 220, borderRadius: 5, background: "#000",
                          border: "2px solid var(--accent)" }} />
        ) : (
          <Thumb pid={pid} rel={comp.background} size={128}
                 title="the plate — click to spotlight"
                 action={ANCHORS.compBgPlate}
                 data={{ "data-path": comp.background }}
                 onClick={() => setSpot(comp.background)} />
        )}
        <div className="col" style={{ flex: 1, gap: 4 }}>
          {(comp.background_history || []).length > 0 && <>
            <div className="muted small">
              {(comp.background_history || []).length + 1} stored plates —
              click to use, ⛶ to spotlight:</div>
            <div className="row">
              {[comp.background, ...(comp.background_history || [])]
                .filter((v, i, a) => a.indexOf(v) === i).map((b) => (
                  <div key={b} className="col" style={{ gap: 2 }}>
                    <Thumb pid={pid} rel={b} size={72}
                           active={b === comp.background}
                           title={IS_CLIP(b) ? `clip · ${b}` : b}
                           action={ANCHORS.compBgPlate} data={{ "data-path": b }}
                           onClick={() => b !== comp.background &&
                                          activateBackground(b)} />
                    <button className="small" style={{ padding: "0 4px" }}
                            onClick={() => setSpot(b)}>
                      {IS_CLIP(b) ? "▶" : "⛶"}</button>
                  </div>
                ))}
            </div>
          </>}
          {bgIsVideo ? (
            <div className="muted small">
              Restyle applies to still plates. To change this background,
              animate a new clip and pick it from the stored backgrounds
              above (or 🎬 compose on another take).
            </div>
          ) : (
          <div className="row">
            <select value={bgMode} data-action={ANCHORS.compBgMode}
                    title="Edit keeps THIS plate and follows guidance (i2i
lane — point it at an instruction-edit model); Regenerate makes a brand-new
plate from scratch (still lane)."
                    onChange={(e) => setBgMode(e.target.value as any)}>
              <option value="edit">✎ edit this plate</option>
              <option value="regen">🎲 regenerate from scratch</option>
            </select>
            <input style={{ flex: 1 }} data-action={ANCHORS.compBgPrompt}
                   placeholder={bgMode === "edit"
                     ? "edit guidance — what should change (layers persist)"
                     : "full image prompt for the new plate (layers persist)"}
                   value={bgPrompt}
                   onChange={(e) => setBgPrompt(e.target.value)} />
            {bgMode === "edit" && (
              <label className="field" title="how much may change:
0.55 keeps the staged geometry · 0.85+ redesigns">
                strength {bgDenoise}
                <input type="range" min="0.35" max="0.95" step="0.05"
                       data-action={ANCHORS.compBgStrength}
                       value={bgDenoise}
                       onChange={(e) => setBgDenoise(Number(e.target.value))} />
              </label>
            )}
            <button disabled={busy || !bgPrompt}
                    data-action={ANCHORS.compBgSubmit}
                    onClick={() => run(() => submitBackgroundHandle())}>
              {bgMode === "edit" ? "✎ apply edit" : "🎲 regenerate"}</button>
          </div>
          )}
        </div>
      </div>

      <div className="row">
        <label className="field">duration
          <input type="number" step="0.5" style={{ width: 76 }}
                 data-action={ANCHORS.compDuration}
                 defaultValue={comp.duration}
                 onBlur={(e) => setDurationHandle(Number(e.target.value))} />
        </label>
        <button className="primary" disabled={busy}
                data-action={ANCHORS.compRender}
                onClick={() => run(() => renderCompHandle())}>
          ▶ render composite</button>
        {latestRender && comp.shot && (
          <button data-action={ANCHORS.compPromote}
                  onClick={() => run(() => promoteHandle())}>
            ⬆ use in timeline</button>
        )}
      </div>
      {latestRender && <Player pid={pid} rel={latestRender.path} />}
      <Spotlight pid={pid} rel={spot} onClose={() => setSpot(null)} />
    </div>
  );
}
