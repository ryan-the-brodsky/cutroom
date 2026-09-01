import { useEffect, useRef, useState } from "react";
import { api, thumbUrl } from "../api";
import ModelPicker from "./ModelPicker";
import Player from "./Player";
import RegionCanvas from "./RegionCanvas";
import Spotlight from "./Spotlight";
import { pushToast, useAsync, useJobWatch, usePlateDims, usePoll } from "../hooks";
import type { CompLayer, CompSummary, Take } from "../types";

/** A media thumb: click = spotlight (or a custom action); active = amber. */
function Thumb({ pid, rel, size = 92, active = false, onClick, title }: {
  pid: string; rel: string; size?: number; active?: boolean;
  onClick: () => void; title?: string;
}) {
  return (
    <img src={thumbUrl(pid, rel, 240)} alt={rel} title={title || rel}
         onClick={onClick} loading="lazy"
         style={{ width: size, aspectRatio: "16/9", objectFit: "cover",
                  borderRadius: 5, cursor: "pointer", background: "#000",
                  border: active ? "2px solid var(--accent)"
                                 : "2px solid var(--line)" }} />
  );
}

/** The cel-composition workbench: stage (region drawing over the plate),
 * layers with independent rerolls, background restyle, render. Used inline
 * by the Shot Editor's Compose tab and by the standalone /comp route. */
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

  if (!comp) return <div className="muted">loading comp…</div>;
  const latestRender = (renders || []).find(
    (r) => r.params?.comp === cid || r.path.includes(`comp-${cid}`));

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
        <RegionCanvas
          pid={pid} plate={comp.background}
          plateW={plateDims[0]} plateH={plateDims[1]}
          region={newRegion} selected={selLayer}
          others={comp.layers.map((L) => ({ id: L.id, region: L.region }))}
          onRegion={setNewRegion}
          onSelect={setSelLayer}
          onLayerChange={(id, region) => changeLayer(id, { region })} />
      ) : <div className="muted">measuring plate…</div>}
      <div className="muted small">
        plate: <code>{comp.background}</code>
        {plateDims && <> · {plateDims[0]}×{plateDims[1]} px</>} · drag a cel to
        move · corners resize · arrows nudge (⇧×10) · del removes · ⌘Z undo ·
        drag empty plate = new cel. Edits auto-preview after 1.5s.
      </div>
      {newRegion && (
        <div className="col card">
          <b>new cel @ [{newRegion.join(", ")}]</b>
          <label className="field">motion prompt (name only what moves)
            <textarea value={newPrompt}
                      onChange={(e) => setNewPrompt(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" disabled={busy || !newPrompt}
              onClick={() => submit(
                `/api/projects/${pid}/comps/${cid}/layers`,
                { region: newRegion, prompt: newPrompt },
                "cel layer generating").then(() => {
                  setNewRegion(null); setNewPrompt("");
                })}>
              ▶ add layer & generate cel</button>
            <button onClick={() => setNewRegion(null)}>cancel</button>
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
        <div className="card" key={L.id}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            {L.clip ? (
              <Thumb pid={pid} rel={L.clip} size={128}
                     title="click to spotlight this cel"
                     onClick={() => setSpot(L.clip)} />
            ) : (
              <div className="muted small" style={{ width: 128 }}>
                no cel yet</div>
            )}
            <div className="col" style={{ flex: 1, gap: 4 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b style={{ cursor: "pointer", color: selLayer === L.id
                            ? "var(--accent)" : undefined }}
                   onClick={() => setSelLayer(L.id)}>{L.id}</b>
                <span className="row muted small">
                  {L.source_plate && <span className="badge keeper"
                    title={`separated figure — cel animates from ${
                      L.source_plate}`}>✂ figure</span>}
                  [{L.region.map(Math.round).join(", ")}] ·
                  <select value={L.matte || "window"}
                          title="window = feathered rectangle; figure =
per-frame isnet-anime matte (only the figure lands on the plate)"
                          onChange={(e) => changeLayer(L.id,
                            { matte: e.target.value })}>
                    <option value="window">window</option>
                    <option value="figure">figure</option>
                  </select> · z{L.z}
                  <button className="small" title="bring forward"
                          onClick={() => changeLayer(L.id,
                            { z: (L.z || 0) + 1 })}>▲</button>
                  <button className="small" title="send back"
                          onClick={() => changeLayer(L.id,
                            { z: (L.z || 0) - 1 })}>▼</button>
                  <label className="field" title="opacity">
                    <input type="range" min="0.1" max="1" step="0.05"
                           style={{ width: 60 }}
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
              title="same prompt, fresh seed — the take you compare against"
              onClick={() => submit(
              `/api/projects/${pid}/comps/${cid}/layers/${L.id}/reroll`,
              {}, `rerolling ${L.id}`)}>🎲 reroll</button>
            <button disabled={busy}
              className={rerollFor === L.id ? "primary" : ""}
              onClick={() => {
                setRerollFor(rerollFor === L.id ? null : L.id);
                setReroll({ prompt: L.prompt || "", backend: "", model: "",
                            seed: "" });
              }}>🎛 directed reroll…</button>
            <button className="danger" disabled={busy} onClick={() =>
              run(() => api(`/api/projects/${pid}/comps/${cid}`, {
                layers: comp.layers.filter((x) => x.id !== L.id),
              }), () => refresh())}>remove</button>
          </div>
          {rerollFor === L.id && (
            <div className="col card">
              <ModelPicker pid={pid} lane="motion" backend={reroll.backend}
                model={reroll.model}
                onChange={(b, m) => setReroll({ ...reroll, backend: b,
                                                model: m })} />
              <label className="field">motion prompt (name only what moves)
                <textarea value={reroll.prompt}
                  onChange={(e) => setReroll({ ...reroll,
                                               prompt: e.target.value })} />
              </label>
              <div className="row">
                <label className="field">seed
                  <input style={{ width: 90 }} placeholder="random"
                    value={reroll.seed}
                    onChange={(e) => setReroll({ ...reroll,
                                                 seed: e.target.value })} />
                </label>
                <span style={{ flex: 1 }} />
                <button className="primary" disabled={busy || !reroll.prompt}
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

      <b>Background</b>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Thumb pid={pid} rel={comp.background} size={128}
               title="the plate — click to spotlight"
               onClick={() => setSpot(comp.background)} />
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
                           onClick={() => b !== comp.background &&
                                          activateBackground(b)} />
                    <button className="small" style={{ padding: "0 4px" }}
                            onClick={() => setSpot(b)}>⛶</button>
                  </div>
                ))}
            </div>
          </>}
          <div className="row">
            <select value={bgMode}
                    title="Edit keeps THIS plate and follows guidance (i2i
lane — point it at an instruction-edit model); Regenerate makes a brand-new
plate from scratch (still lane)."
                    onChange={(e) => setBgMode(e.target.value as any)}>
              <option value="edit">✎ edit this plate</option>
              <option value="regen">🎲 regenerate from scratch</option>
            </select>
            <input style={{ flex: 1 }}
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
                       value={bgDenoise}
                       onChange={(e) => setBgDenoise(Number(e.target.value))} />
              </label>
            )}
            <button disabled={busy || !bgPrompt} onClick={() => submit(
              `/api/projects/${pid}/comps/${cid}/background/reroll`,
              { prompt: bgPrompt, denoise: bgDenoise, mode: bgMode },
              bgMode === "edit" ? "editing the plate…"
                                : "regenerating the plate…")}>
              {bgMode === "edit" ? "✎ apply edit" : "🎲 regenerate"}</button>
          </div>
        </div>
      </div>

      <div className="row">
        <label className="field">duration
          <input type="number" step="0.5" style={{ width: 76 }}
                 defaultValue={comp.duration}
                 onBlur={(e) => api(`/api/projects/${pid}/comps/${cid}`,
                   { duration: Number(e.target.value) }).then(refresh)} />
        </label>
        <button className="primary" disabled={busy} onClick={() => submit(
          `/api/projects/${pid}/comps/${cid}/render`, {}, "comp rendering")}>
          ▶ render composite</button>
        {latestRender && comp.shot && (
          <button onClick={() => api(
            `/api/projects/${pid}/shots/${comp.shot}/override`,
            { source: latestRender.path })
            .then(() => { pushToast({ text: "comp → timeline source" });
                          onChanged?.(); })}>
            ⬆ use in timeline</button>
        )}
      </div>
      {latestRender && <Player pid={pid} rel={latestRender.path} />}
      <Spotlight pid={pid} rel={spot} onClose={() => setSpot(null)} />
    </div>
  );
}
