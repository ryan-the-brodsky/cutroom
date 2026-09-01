import { Link, useParams } from "react-router-dom";
import CompEditor from "../components/CompEditor";
import { usePoll } from "../hooks";
import type { CompSummary } from "../types";

/** Standalone (deep-linkable) view of one composition; the same workbench
 * is embedded in the Shot Editor's Compose tab. */
export default function ComposerPage() {
  const { pid, cid } = useParams() as { pid: string; cid: string };
  const { data: comps } = usePoll<CompSummary[]>(
    `/api/projects/${pid}/comps`, 0);
  const comp = comps?.find((c) => c.cid === cid);
  return (
    <div>
      <h2 style={{ margin: "0 0 12px" }}>
        <Link to={`/p/${pid}${comp?.shot ? `/shot/${comp.shot}` : ""}`}>←</Link>
        {" "}comp <b>{cid}</b>
        {comp?.shot && <span className="muted"> · shot {comp.shot}</span>}
      </h2>
      <div style={{ maxWidth: 980 }}>
        <CompEditor pid={pid} cid={cid} />
      </div>
    </div>
  );
}
