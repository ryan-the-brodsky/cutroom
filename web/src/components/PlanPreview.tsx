import { useState } from "react";
import { api } from "../api";
import { pushToast, useAsync } from "../hooks";
import type { Plan } from "../types";

/** An EditPlan, previewed before anything runs. Apply turns ops into jobs. */
export default function PlanPreview({ pid, plan, source, onApplied }: {
  pid: string;
  plan: Plan;
  source: string;
  onApplied?: (results: any[]) => void;
}) {
  const { busy, error, run } = useAsync();
  const [applied, setApplied] = useState<any[] | null>(null);
  return (
    <div className="plan col">
      <div className="row">
        <b>EditPlan</b>
        <span className="muted small">compiled by {source}</span>
      </div>
      {plan.ops.map((op, i) => (
        <div className="op" key={i}>
          <b>{op.op}</b>{" "}
          {Object.entries(op).filter(([k]) => k !== "op")
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ")}
        </div>
      ))}
      {plan.note && <div className="muted small">{plan.note}</div>}
      {error && <div className="error">{error}</div>}
      {applied ? (
        <div className="ok">
          applied — {applied.filter((r) => r.job).length} job(s) queued
        </div>
      ) : (
        <div className="row">
          <button className="primary" disabled={busy}
            onClick={() => run(
              () => api(`/api/projects/${pid}/plan/apply`, plan),
              (d: any) => {
                setApplied(d.results);
                pushToast({ text: `plan applied: ${d.results.length} op(s)`,
                            job: d.results.find((r: any) => r.job)?.job });
                onApplied?.(d.results);
              })}>
            {busy ? "applying…" : "▶ apply plan"}
          </button>
        </div>
      )}
    </div>
  );
}
