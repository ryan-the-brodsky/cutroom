import { mediaUrl } from "../api";

const VIDEO = [".mp4", ".webm", ".mov"];
const AUDIO = [".wav", ".mp3", ".m4a"];

export default function Player({ pid, rel }: { pid: string; rel: string | null }) {
  if (!rel) {
    return <div className="monitor" style={{ aspectRatio: "16/9",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "var(--dim)" }}>no source</div>;
  }
  const url = mediaUrl(pid, rel);
  const low = rel.toLowerCase();
  if (VIDEO.some((e) => low.endsWith(e))) {
    return <div className="monitor">
      <video key={url} src={url} controls loop autoPlay muted />
    </div>;
  }
  if (AUDIO.some((e) => low.endsWith(e))) {
    return <audio key={url} src={url} controls style={{ width: "100%" }} />;
  }
  return <div className="monitor"><img src={url} alt={rel} /></div>;
}
