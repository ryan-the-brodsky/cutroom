import { useEffect, useRef } from "react";
import { mediaUrl } from "../api";
import { useSequenceContext } from "../runtime/player/composition";
import type { Clip } from "../timeline/model";

/** Fill the (already CSS-scaled) player content host. */
const fill: React.CSSProperties = {
  position: "absolute", inset: 0, width: "100%", height: "100%",
  objectFit: "contain",
};

/** A clip's source frame → a plain <video> seek. The player's clock drives the
 * Sequence's localFrame; we map it to source time via the clip's in-point and
 * source fps. DOM <video> seeking is preview-grade (nearest keyframe + async
 * seeked latency) — export goes through the frame-exact engine path. */
export function PreviewVideo({ pid, clip, fps }: {
  pid: string; clip: Clip; fps: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const seq = useSequenceContext();
  const local = seq?.localFrame ?? 0;
  const srcFps = clip.source_fps ?? fps;
  const inPoint = clip.source_start ?? 0;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const target = inPoint / srcFps + local / fps;
    if (Number.isFinite(target) && Math.abs(v.currentTime - target) > 1 / (fps * 2)) {
      try { v.currentTime = target; } catch { /* not seekable yet */ }
    }
  }, [local, inPoint, srcFps, fps]);
  return (
    <video ref={ref} src={mediaUrl(pid, clip.source!)} muted playsInline
           preload="auto" style={fill} />
  );
}

export function PreviewImage({ pid, clip }: { pid: string; clip: Clip }) {
  return <img src={mediaUrl(pid, clip.source!)} alt="" style={fill} />;
}

export function PreviewText({ clip }: { clip: Clip }) {
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center",
                  justifyContent: "center" }}>
      <span style={{ color: clip.color ?? "#fff", fontSize: 48, fontWeight: 700,
                     textShadow: "0 2px 8px #000" }}>{clip.text}</span>
    </div>
  );
}
