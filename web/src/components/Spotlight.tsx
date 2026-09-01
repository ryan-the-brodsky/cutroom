import { useEffect } from "react";
import { mediaUrl } from "../api";

/** Full-screen focus view for any media rel. Click anywhere / Esc closes. */
export default function Spotlight({ pid, rel, onClose }: {
  pid: string; rel: string | null; onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  if (!rel) return null;
  const url = mediaUrl(pid, rel);
  const isClip = /\.(mp4|webm|mov)$/i.test(rel);
  return (
    <div onClick={onClose}
         style={{ position: "fixed", inset: 0, zIndex: 100,
                  background: "rgba(0,0,0,0.88)", display: "flex",
                  flexDirection: "column", alignItems: "center",
                  justifyContent: "center", cursor: "zoom-out", gap: 8 }}>
      {isClip ? (
        <video src={url} controls autoPlay loop
               onClick={(e) => e.stopPropagation()}
               style={{ maxWidth: "92vw", maxHeight: "86vh" }} />
      ) : (
        <img src={url} alt={rel}
             style={{ maxWidth: "92vw", maxHeight: "86vh",
                      objectFit: "contain" }} />
      )}
      <code className="small" style={{ color: "#bbb" }}>{rel} — esc to close</code>
    </div>
  );
}
