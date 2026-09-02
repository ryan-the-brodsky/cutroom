import { useEffect, useRef, useState } from "react";
import { ANCHORS } from "../agent/contract";
import { api, thumbUrl } from "../api";
import { pushToast, useAsync, useJobWatch } from "../hooks";

type Pt = { x: number; y: number; label: 0 | 1 };

/** The "pull this character" gesture — click the figure, watch the matte
 * preview land on the plate, refine with more clicks (− points carve away
 * mis-grabs), then separate: mask → clean-plate inpaint → a staged comp
 * whose figure layer is ready to animate. All coords in true plate px. */
export default function SeparateCanvas({ pid, sid, plate, plateW, plateH,
                                         seconds, onDone }: {
  pid: string; sid: string; plate: string; plateW: number; plateH: number;
  seconds?: number; onDone: (comp: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskImg = useRef<HTMLImageElement | null>(null);
  const [points, setPoints] = useState<Pt[]>([]);
  const [mode, setMode] = useState<0 | 1>(1);
  const [preview, setPreview] =
    useState<{ bbox: number[] | null; coverage: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [watchJob, setWatchJob] = useState<string | null>(null);
  const { busy, error, run } = useAsync();

  const scale = () => {
    const w = wrapRef.current!;
    return [w.clientWidth / plateW, w.clientHeight / plateH];
  };

  const draw = () => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight;
    const ctx = canvas.getContext("2d")!;
    const [sx, sy] = scale();
    if (maskImg.current) {                     // the matte, as amber glass
      ctx.globalAlpha = 0.5;
      ctx.globalCompositeOperation = "screen";
      ctx.drawImage(maskImg.current, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    if (preview?.bbox) {
      const [l, t, r, b] = preview.bbox;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#e8b34b"; ctx.lineWidth = 2;
      ctx.strokeRect(l * sx, t * sy, (r - l) * sx, (b - t) * sy);
      ctx.setLineDash([]);
    }
    for (const p of points) {                  // + green · − red
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 6, 0, Math.PI * 2);
      ctx.fillStyle = p.label ? "#4bd47e" : "#e05555";
      ctx.fill();
      ctx.strokeStyle = "#111"; ctx.lineWidth = 2; ctx.stroke();
    }
  };

  useEffect(draw);

  // clicks → debounced live preview from /segment
  useEffect(() => {
    if (!points.length) { maskImg.current = null; setPreview(null); return; }
    const t = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const d = await api(`/api/projects/${pid}/segment`, {
          image: plate,
          prompts: points.map((p) => ({ type: "point",
                                        data: [p.x, p.y], label: p.label })),
        });
        const img = new Image();
        img.onload = () => { maskImg.current = img; draw(); };
        img.src = d.mask;
        setPreview({ bbox: d.bbox, coverage: d.coverage });
      } catch (e: any) {
        pushToast({ text: `segment failed: ${e.message}` });
      } finally { setPreviewBusy(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [JSON.stringify(points)]);

  useJobWatch(watchJob, (ok, result) => {
    setWatchJob(null);
    pushToast({ text: ok ? "✂ figure separated — comp staged"
                         : "✗ separation failed (see Jobs)" });
    if (ok && result?.comp) onDone(result.comp);
  });

  const separate = () => run(
    () => api(`/api/projects/${pid}/separate`, {
      shot: sid, plate, duration: seconds,
      name: `${sid}-fig`,
      prompts: points.map((p) => ({ type: "point",
                                    data: [p.x, p.y], label: p.label })),
    }),
    (d: any) => { pushToast({ text: "separating figure…", job: d.job });
                  setWatchJob(d.job); });

  return (
    <div className="col card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>✂ separate a figure</b>
        <span className="muted small">
          click the figure · {points.length} point(s)
          {preview && <> · matte {Math.round(preview.coverage * 1000) / 10}%
            of frame</>}
          {previewBusy && " · segmenting…"}
        </span>
      </div>
      <div className="region-wrap" ref={wrapRef}
           data-action={ANCHORS.sepCanvas}
           style={{ cursor: "crosshair" }}>
        <img src={thumbUrl(pid, plate, 960)} alt="plate" draggable={false} />
        <canvas ref={canvasRef}
          onMouseDown={(e) => {
            const r = wrapRef.current!.getBoundingClientRect();
            const [sx, sy] = scale();
            const x = Math.round((e.clientX - r.left) / sx);
            const y = Math.round((e.clientY - r.top) / sy);
            // shift/alt-click = negative regardless of mode toggle
            const label: 0 | 1 =
              (e.shiftKey || e.altKey) ? 0 : mode;
            setPoints([...points, { x, y, label }]);
          }} />
      </div>
      <div className="row">
        <button className={`small ${mode === 1 ? "primary" : ""}`}
                data-action={ANCHORS.sepInclude}
                onClick={() => setMode(1)}>＋ include</button>
        <button className={`small ${mode === 0 ? "primary" : ""}`}
                title="or shift-click anywhere"
                data-action={ANCHORS.sepExclude}
                onClick={() => setMode(0)}>－ exclude</button>
        <button className="small" disabled={!points.length}
                data-action={ANCHORS.sepUndo}
                onClick={() => setPoints(points.slice(0, -1))}>undo</button>
        <button className="small" disabled={!points.length}
                data-action={ANCHORS.sepClear}
                onClick={() => setPoints([])}>clear</button>
        <span style={{ flex: 1 }} />
        <button className="primary"
                data-action={ANCHORS.sepSubmit}
                disabled={busy || !!watchJob || !points.length}
                onClick={separate}>
          {watchJob ? "separating…" : "✂ separate & clean plate"}</button>
      </div>
      <div className="muted small">
        SAM picks the figure from your clicks; isnet-anime cuts the cel edge;
        LaMa paints the clean plate behind it. You get a comp: clean plate +
        a figure layer that animates from the original plate — no ghost where
        the figure stood.
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
