import { useEffect, useState } from "react";
import { ANCHORS } from "../agent/contract";
import { api, getToken, setToken } from "../api";
import { currentProject } from "../agent/context";
import { useAsync, usePoll } from "../hooks";
import type { BackendInfo } from "../types";

function BackendRow({ b, onSaved }: { b: BackendInfo; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ label: b.label, base_url: b.base_url,
                                     api_key: "", options: JSON.stringify(
                                       b.options || {}, null, 1) });
  const [health, setHealth] = useState<any>(null);
  const { busy, error, run, setError } = useAsync();

  const save = () => {
    let options: any;
    try { options = JSON.parse(form.options || "{}"); }
    catch { setError("options is not valid JSON"); return; }
    run(() => api("/api/backends", {
      id: b.id, type: b.type, label: form.label, base_url: form.base_url,
      api_key: form.api_key || undefined, options, enabled: b.enabled,
    }), () => { setEdit(false); onSaved(); });
  };

  return (
    <div className="card" style={{ marginBottom: 8 }}
         data-action={ANCHORS.settingsBackend} data-id={b.id}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <b>{b.label || b.id}</b>
          <span className="badge">{b.type}</span>
          {b.lanes.map((l) => <span key={l} className="badge motion">{l}</span>)}
          {b.api_key_set && <span className="badge keeper">key set</span>}
        </div>
        <div className="row">
          <button data-action={ANCHORS.settingsBackendEnable} data-id={b.id}
            onClick={() => api("/api/backends", { id: b.id,
            type: b.type, enabled: !b.enabled }).then(onSaved)}>
            {b.enabled ? "disable" : "enable"}
          </button>
          <button data-action={ANCHORS.settingsBackendHealth} data-id={b.id}
            onClick={() =>
            api(`/api/backends/${b.id}/health`).then(setHealth)
              .catch((e) => setHealth({ up: false, error: e.message }))}>
            health
          </button>
          <button data-action={ANCHORS.settingsBackendEdit} data-id={b.id}
                  onClick={() => setEdit(!edit)}>⚙</button>
        </div>
      </div>
      {health && (
        <div className={health.up ? "ok" : "error"}>
          {JSON.stringify(health)}
        </div>
      )}
      {edit && (
        <div className="col">
          <div className="row">
            <label className="field">label
              <input value={form.label}
                     data-action={ANCHORS.settingsBackendLabel} data-id={b.id}
                     onChange={(e) =>
                setForm({ ...form, label: e.target.value })} /></label>
            <label className="field">base url
              <input style={{ width: 260 }} value={form.base_url}
                     data-action={ANCHORS.settingsBackendUrl} data-id={b.id}
                     onChange={(e) =>
                       setForm({ ...form, base_url: e.target.value })} /></label>
            <label className="field">
              api key {b.api_key_set && `(stored: ${b.api_key_hint})`}
              <input type="password" placeholder="leave blank to keep"
                     data-action={ANCHORS.settingsBackendKey} data-id={b.id}
                     value={form.api_key} onChange={(e) =>
                       setForm({ ...form, api_key: e.target.value })} /></label>
          </div>
          <label className="field">options (JSON — lane overrides, models,
            concurrency, remote)
            <textarea className="mono" value={form.options}
              data-action={ANCHORS.settingsBackendOptions} data-id={b.id}
              onChange={(e) =>
              setForm({ ...form, options: e.target.value })} /></label>
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button className="primary" disabled={busy} onClick={save}
                    data-action={ANCHORS.settingsBackendSave} data-id={b.id}>
              save</button>
            <button className="danger"
              data-action={ANCHORS.settingsBackendDelete} data-id={b.id}
              onClick={() =>
              api(`/api/backends/${b.id}/delete`, {}).then(onSaved)}>
              delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

const LANES = ["still", "i2i", "motion", "vo", "music", "sfx", "direction"];

/** Which backend (and model) each generative lane uses for the CURRENT project.
 * The Shot Editor's model picker shows this as "(project default)"; this is where
 * it is set, and what the agent's `set_lane_default` tool drives. */
function LaneDefaults() {
  const pid = currentProject();
  const { data: lanes } = usePoll<Record<string, any[]>>("/api/lanes", 0);
  const [defaults, setDefaults] =
    useState<Record<string, { backend: string | null; model: string | null }>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const { busy, error, run } = useAsync();
  const load = () => {
    if (!pid) return;
    api(`/api/projects/${pid}/lanes`).then((d: any) => setDefaults(d || {}))
      .catch(() => {});
  };
  useEffect(load, [pid]);
  if (!pid) return null;
  return (
    <>
      <h3>Lane defaults · {pid}</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>
        The backend each lane runs on when a generate console leaves it blank.
        Admin-only on a hosted demo.
      </div>
      {error && <div className="error">{error}</div>}
      {LANES.filter((l) => (lanes?.[l] || []).length > 0).map((lane) => {
        const cur = defaults[lane] || { backend: null, model: null };
        return (
          <div className="row" key={lane} style={{ marginBottom: 4 }}
               data-action={ANCHORS.settingsLane} data-lane={lane}>
            <span className="badge motion" style={{ minWidth: 64 }}>{lane}</span>
            <select value={cur.backend || ""} data-lane={lane}
                    onChange={(e) => run(
                      () => api(`/api/projects/${pid}/lanes`,
                                { lane, backend: e.target.value || null,
                                  model: cur.model || null }), load)}>
              <option value="">(first enabled)</option>
              {(lanes?.[lane] || []).map((b: any) => (
                <option key={b.id} value={b.id}>{b.label || b.id}</option>
              ))}
            </select>
            <input placeholder={cur.model || "model (optional)"}
                   style={{ width: 200 }}
                   data-action={ANCHORS.settingsLaneModel} data-lane={lane}
                   value={models[lane] ?? ""}
                   onChange={(e) => setModels({ ...models, [lane]: e.target.value })} />
            <button className="small" disabled={busy}
                    data-action={ANCHORS.settingsLaneSave} data-lane={lane}
                    onClick={() => run(
                      () => api(`/api/projects/${pid}/lanes`,
                                { lane, backend: cur.backend,
                                  model: models[lane] ?? cur.model ?? null }), load)}>
              save</button>
          </div>
        );
      })}
    </>
  );
}

export default function SettingsPage() {
  const { data: backends, refresh } =
    usePoll<BackendInfo[]>("/api/backends", 0);
  const { data: types } = usePoll<any[]>("/api/backends/types", 0);
  const [adding, setAdding] = useState(false);
  const [nform, setNform] = useState({ id: "", type: "comfyui",
                                       base_url: "", api_key: "" });
  const [tok, setTok] = useState(getToken());
  const { busy, error, run } = useAsync();
  useEffect(() => { setTok(getToken()); }, []);

  return (
    <div>
      <h2>Settings</h2>

      <h3>Generation backends</h3>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Every generative lane (stills · img2img · motion · voice) is served by
        a pluggable backend: your ComfyUI boxes (local or remote VMs), or
        hosted APIs with your own keys. GPU backends run their jobs strictly
        serial by default.
      </div>
      {(backends || []).map((b) => (
        <BackendRow b={b} key={b.id} onSaved={refresh} />
      ))}

      {adding ? (
        <div className="card">
          <div className="row">
            <label className="field">id
              <input value={nform.id} data-action={ANCHORS.settingsAddId}
                     onChange={(e) =>
                setNform({ ...nform, id: e.target.value })} /></label>
            <label className="field">type
              <select value={nform.type} data-action={ANCHORS.settingsAddType}
                      onChange={(e) =>
                setNform({ ...nform, type: e.target.value })}>
                {(types || []).map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.type} ({t.lanes.join(",")})</option>
                ))}
              </select></label>
            <label className="field">base url
              <input value={nform.base_url} placeholder="http://gpu-vm:8188"
                     data-action={ANCHORS.settingsAddUrl}
                     onChange={(e) =>
                       setNform({ ...nform, base_url: e.target.value })} />
            </label>
            <label className="field">api key
              <input type="password" value={nform.api_key}
                     data-action={ANCHORS.settingsAddKey}
                     onChange={(e) =>
                setNform({ ...nform, api_key: e.target.value })} /></label>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button className="primary" disabled={busy || !nform.id}
              data-action={ANCHORS.settingsAddSubmit}
              onClick={() => run(() => api("/api/backends", {
                ...nform, enabled: true }),
                () => { setAdding(false); refresh(); })}>add</button>
            <button data-action={ANCHORS.settingsAddCancel}
                    onClick={() => setAdding(false)}>cancel</button>
          </div>
        </div>
      ) : (
        <button data-action={ANCHORS.settingsAdd}
                onClick={() => setAdding(true)}>+ add backend</button>
      )}

      <LaneDefaults />

      <h3>API token</h3>
      <div className="muted small">Set when the server runs with
        CUTROOM_AUTH_TOKEN (hosted mode). Stored in this browser.</div>
      <div className="row" style={{ marginTop: 6 }}>
        <input type="password" value={tok} data-action={ANCHORS.settingsToken}
               onChange={(e) => setTok(e.target.value)} />
        <button data-action={ANCHORS.settingsTokenSave}
                onClick={() => { setToken(tok); location.reload(); }}>
          save token</button>
      </div>
    </div>
  );
}
