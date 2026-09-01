import { useEffect, useState } from "react";
import { ANCHORS } from "../agent/contract";
import { api } from "../api";

interface LaneBackend { id: string; label: string; type: string;
                        enabled: boolean }

/** The lane → backend → model chain, as a picker. Shows the PROJECT's lane
 * default as the initial selection so what you see is what will run. */
export default function ModelPicker({ pid, lane, backend, model, onChange }: {
  pid: string;
  lane: string;
  backend: string;
  model: string;
  onChange: (backend: string, model: string) => void;
}) {
  const [lanes, setLanes] = useState<Record<string, LaneBackend[]>>({});
  const [laneDefaults, setLaneDefaults] =
    useState<Record<string, { backend: string | null; model: string | null }>>({});
  const [models, setModels] = useState<{ id: string; label?: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api("/api/lanes").then(setLanes).catch(() => {});
    api(`/api/projects/${pid}/lanes`).then(setLaneDefaults).catch(() => {});
  }, [pid]);

  const backends = (lanes[lane] || []).filter((b) => b.enabled);
  const projectDefault = laneDefaults[lane]?.backend || "";
  const effective = backend || projectDefault || backends[0]?.id || "";
  const isDefault = !backend || backend === projectDefault;

  useEffect(() => {
    if (!effective) { setModels([]); return; }
    setLoading(true);
    api(`/api/backends/${effective}/models?lane=${lane}`)
      .then((d) => setModels(d.models || []))
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, [effective, lane]);

  return (
    <div className="row" data-action={ANCHORS.genModel} data-lane={lane}>
      <label className="field">
        backend {isDefault && projectDefault &&
          <span className="ok">(project default)</span>}
        <select value={effective} data-action={`${ANCHORS.genModel}.backend`}
                data-lane={lane}
                onChange={(e) => onChange(e.target.value, "")}>
          {backends.length === 0 && <option value="">none enabled</option>}
          {backends.map((b) => (
            <option key={b.id} value={b.id}>{b.label} ({b.type})</option>
          ))}
        </select>
      </label>
      <label className="field">
        {lane === "vo" ? "voice" : "model"}
        {models.length > 0 ? (
          <select value={model} onChange={(e) => onChange(effective,
                                                          e.target.value)}>
            <option value="">default</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label || m.id}</option>
            ))}
          </select>
        ) : (
          <input placeholder={loading ? "discovering…" : "default"}
                 value={model}
                 onChange={(e) => onChange(effective, e.target.value)} />
        )}
      </label>
    </div>
  );
}
