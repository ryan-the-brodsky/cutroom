import { useEffect, useRef, useState } from "react";
import { thumbUrl } from "../api";

type Layer = { id: string; region: number[] };
type Drag =
  | { kind: "draw"; x: number; y: number }
  | { kind: "move"; id: string; region: number[]; dx: number; dy: number }
  | { kind: "resize"; id: string; region: number[]; corner: number };

const HANDLE = 10; // px hit radius for resize corners (canvas space)

/** The stage — standard direct manipulation, all coords in true PLATE px:
 *  · drag on empty plate      → plan a new cel region
 *  · click a cel              → select (arrows nudge ±1 / shift ±10,
 *                               delete removes — wired by the parent)
 *  · drag inside a cel        → move it
 *  · drag a corner handle     → resize it
 * Every change lands via onLayerChange; the parent persists + re-renders. */
export default function RegionCanvas({ pid, plate, plateW, plateH, region,
                                       others, selected, onRegion,
                                       onSelect, onLayerChange }: {
  pid: string;
  plate: string;
  plateW: number;
  plateH: number;
  region: number[] | null;
  others?: Layer[];
  selected?: string | null;
  onRegion: (r: number[]) => void;
  onSelect?: (id: string | null) => void;
  onLayerChange?: (id: string, region: number[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cur, setCur] = useState<number[] | null>(null);
  const [live, setLive] = useState<Layer | null>(null);   // mid-gesture rect

  const scale = () => {
    const wrap = wrapRef.current!;
    return [wrap.clientWidth / plateW, wrap.clientHeight / plateH];
  };

  const draw = () => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight;
    const ctx = canvas.getContext("2d")!;
    const [sx, sy] = scale();
    const paint = (r: number[], color: string, label?: string,
                   sel = false, dash = false) => {
      ctx.setLineDash(dash ? [6, 4] : []);
      ctx.strokeStyle = color; ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeRect(r[0] * sx, r[1] * sy, (r[2] - r[0]) * sx,
                     (r[3] - r[1]) * sy);
      ctx.setLineDash([]);
      if (sel) {  // corner handles
        ctx.fillStyle = color;
        for (const [cx, cy] of [[r[0], r[1]], [r[2], r[1]],
                                [r[0], r[3]], [r[2], r[3]]]) {
          ctx.fillRect(cx * sx - 4, cy * sy - 4, 8, 8);
        }
      }
      if (label) {
        ctx.fillStyle = color; ctx.font = "11px monospace";
        ctx.fillText(label, r[0] * sx + 4, r[1] * sy + 13);
      }
    };
    for (const o of others || []) {
      if (live?.id === o.id) continue;
      paint(o.region, "#b48ead", o.id, selected === o.id);
    }
    if (live) {
      const [l, t, r, b] = live.region;
      paint(live.region, "#b48ead",
            `${live.id} ${r - l}×${b - t} @ ${l},${t}`, true, true);
    }
    const active = cur || region;
    if (active) paint(active, "#e8b34b",
                      `${Math.round(active[2] - active[0])}×` +
                      `${Math.round(active[3] - active[1])}`);
  };
  useEffect(draw);

  const toPlate = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(plateW,
        ((e.clientX - rect.left) / rect.width) * plateW)),
      y: Math.max(0, Math.min(plateH,
        ((e.clientY - rect.top) / rect.height) * plateH)),
    };
  };

  const cornerHit = (p: { x: number; y: number }, o: Layer): number | null => {
    const [sx] = scale();
    const tol = HANDLE / sx;
    const [l, t, r, b] = o.region;
    const corners = [[l, t], [r, t], [l, b], [r, b]];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p.x - corners[i][0]) < tol &&
          Math.abs(p.y - corners[i][1]) < tol) return i;
    }
    return null;
  };

  const hit = (p: { x: number; y: number }): Layer | null => {
    for (const o of [...(others || [])].reverse()) {
      const [l, t, r, b] = o.region;
      if (p.x >= l && p.x <= r && p.y >= t && p.y <= b) return o;
    }
    return null;
  };

  return (
    <div className="region-wrap" ref={wrapRef}>
      <img src={thumbUrl(pid, plate, 960)} alt="plate" draggable={false} />
      <canvas
        ref={canvasRef}
        onMouseDown={(e) => {
          const p = toPlate(e);
          if (onLayerChange) {
            // resize handle of the selected layer first, then body hits
            const selLayer = (others || []).find((o) => o.id === selected);
            if (selLayer) {
              const c = cornerHit(p, selLayer);
              if (c !== null) {
                setDrag({ kind: "resize", id: selLayer.id,
                          region: selLayer.region, corner: c });
                setLive(selLayer);
                return;
              }
            }
            const layer = hit(p);
            if (layer) {
              onSelect?.(layer.id);
              setDrag({ kind: "move", id: layer.id, region: layer.region,
                        dx: p.x - layer.region[0], dy: p.y - layer.region[1] });
              setLive(layer);
              return;
            }
            onSelect?.(null);
          }
          setDrag({ kind: "draw", x: p.x, y: p.y });
        }}
        onMouseMove={(e) => {
          if (!drag) return;
          const p = toPlate(e);
          if (drag.kind === "draw") {
            setCur([Math.min(drag.x, p.x), Math.min(drag.y, p.y),
                    Math.max(drag.x, p.x), Math.max(drag.y, p.y)]
              .map(Math.round));
          } else if (drag.kind === "move") {
            const [l, t, r, b] = drag.region;
            const w = r - l, h = b - t;
            const nl = Math.max(0, Math.min(plateW - w,
                                            Math.round(p.x - drag.dx)));
            const nt = Math.max(0, Math.min(plateH - h,
                                            Math.round(p.y - drag.dy)));
            setLive({ id: drag.id, region: [nl, nt, nl + w, nt + h] });
          } else {
            let [l, t, r, b] = drag.region;
            if (drag.corner === 0) { l = p.x; t = p.y; }
            if (drag.corner === 1) { r = p.x; t = p.y; }
            if (drag.corner === 2) { l = p.x; b = p.y; }
            if (drag.corner === 3) { r = p.x; b = p.y; }
            const nr = [Math.min(l, r), Math.min(t, b),
                        Math.max(l, r), Math.max(t, b)].map(Math.round);
            if (nr[2] - nr[0] > 24 && nr[3] - nr[1] > 24) {
              setLive({ id: drag.id, region: nr });
            }
          }
        }}
        onMouseUp={() => {
          if (drag?.kind === "draw" && cur &&
              cur[2] - cur[0] > 8 && cur[3] - cur[1] > 8) {
            onRegion(cur);
          } else if (drag && drag.kind !== "draw" && live && onLayerChange) {
            const changed = JSON.stringify(drag.region) !==
              JSON.stringify(live.region);
            if (changed) onLayerChange(live.id, live.region);
          }
          setDrag(null); setCur(null); setLive(null);
        }}
        onMouseLeave={() => { setDrag(null); setCur(null); setLive(null); }}
      />
    </div>
  );
}
