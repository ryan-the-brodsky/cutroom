import { useEffect, useRef, useState } from "react";
import { api, sse } from "../api";
import { usePoll } from "../hooks";
import type { Job } from "../types";

function ago(ts: number | null) {
  if (!ts) return "";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function LogView({ jobId, status }: { jobId: string; status: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLines([]);
    const live = status === "running" || status === "queued";
    if (!live) {
      api(`/api/jobs/${jobId}/log?tail=200`)
        .then((d: any) => setLines(d.lines));
      return;
    }
    const ctrl = new AbortController();
    sse(`/api/jobs/${jobId}/watch`, undefined, (ev) => {
      if (ev.kind === "log") setLines((ls) => [...ls.slice(-400), ev.text!]);
      if (ev.kind === "status" && ev.error) {
        setLines((ls) => [...ls, `ERROR: ${ev.error}`]);
      }
    }, ctrl.signal).catch(() => {});
    return () => ctrl.abort();
  }, [jobId, status]);
  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [lines]);
  return <div className="log" ref={boxRef}>
    {lines.length ? lines.join("\n") : "(no output yet)"}</div>;
}

export default function JobsPage() {
  const { data: jobs, refresh } = usePoll<Job[]>("/api/jobs?limit=80", 3000);
  const [sel, setSel] = useState<string | null>(null);
  const selected = jobs?.find((j) => j.id === sel);
  return (
    <div className="split">
      <div>
        <h2>Jobs</h2>
        <table className="list">
          <thead><tr>
            <th>title</th><th>pool</th><th>status</th><th>when</th><th />
          </tr></thead>
          <tbody>
            {(jobs || []).map((j) => (
              <tr key={j.id} onClick={() => setSel(j.id)}
                  style={{ cursor: "pointer",
                           background: sel === j.id ? "var(--bg3)" : "" }}>
                <td>{j.title}</td>
                <td className="muted small mono">{j.pool}</td>
                <td className={`status-${j.status}`}>{j.status}</td>
                <td className="muted small">{ago(j.created_at)}</td>
                <td>
                  {(j.status === "queued" || j.status === "running") && (
                    <button className="danger small" onClick={(e) => {
                      e.stopPropagation();
                      api(`/api/jobs/${j.id}/cancel`, {}).then(refresh);
                    }}>✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        {selected ? (
          <div className="col">
            <h3>{selected.title}</h3>
            <div className="muted small mono">
              {selected.id} · {selected.type} · worker {selected.worker || "—"}
            </div>
            {selected.error && <div className="error">{selected.error}</div>}
            {selected.result && Object.keys(selected.result).length > 0 && (
              <div className="log">{JSON.stringify(selected.result, null, 1)}
              </div>
            )}
            <LogView jobId={selected.id} status={selected.status} />
          </div>
        ) : <div className="muted">select a job to see its log</div>}
      </div>
    </div>
  );
}
