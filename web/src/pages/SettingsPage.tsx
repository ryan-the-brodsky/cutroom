import { useEffect, useState } from "react";
import { ANCHORS } from "../agent/contract";
import { api, getToken, setToken } from "../api";
import { currentProject } from "../agent/context";
import { useAsync, usePoll } from "../hooks";
import type { MotionModel } from "../agent/tools/plan";
import type { BackendInfo, Project } from "../types";

/**
 * Settings, read two ways.
 *
 * A visitor with a view-only link is not here to configure anything: they are here to find
 * out what is behind the studio. So everybody gets the same informational page — what is
 * switched on, what each part costs, where each lane of the film goes — and an admin gets
 * the controls underneath it. Nothing in the viewer half can write, and nothing in it says
 * the word "backend" without saying what a backend does.
 */

// ------------------------------------------------------------------ words

/** One line per lane, in the words a visitor would use. */
const LANE_COPY: Record<string, { title: string; line: string }> = {
  still: { title: "Stills", line: "Draws the first frame of a shot from what the script says." },
  i2i: { title: "Restyles", line: "Redraws a frame that already exists, so a look can change without starting over." },
  motion: { title: "Motion", line: "Turns a still into a moving clip." },
  vo: { title: "Voice", line: "Speaks the lines the characters say." },
  music: { title: "Music", line: "Writes the score that runs under the cut." },
  sfx: { title: "Effects", line: "Makes the sound effects laid against the picture." },
  direction: { title: "Director", line: "Reads the film and answers in the director chat." },
};
const LANES = ["still", "i2i", "motion", "vo", "music", "sfx", "direction"];
const laneTitle = (lane: string) => LANE_COPY[lane]?.title || lane;

/** What the motion registry calls a shot type, in plain words. */
const REGISTER_COPY: Record<string, string> = {
  dialogue_closeup: "close-ups",
  wide_tableau: "wide shots",
  effects_burst: "bursts of effect",
  legible_text: "readable on-screen text",
};

/** Dollars, to the cent, and to four places when the cent would round a real
 * price to nothing (a per-second model costs $0.0216, not $0.02). */
function money(n: number): string {
  const cents = n.toFixed(2);
  if (Number(cents) === n) return `$${cents}`;
  return `$${n.toFixed(4).replace(/(\.\d{3})0$/, "$1")}`;
}

function priceOf(m: MotionModel): string {
  if (typeof m.cost?.per_second_usd === "number") {
    return `${money(m.cost.per_second_usd)} a second`;
  }
  if (typeof m.cost?.per_clip_usd === "number") {
    return `${money(m.cost.per_clip_usd)} a clip`;
  }
  return "no charge";
}

interface MotionProfile { model?: string | null; models?: MotionModel[] }
interface BackendRow extends BackendInfo {
  motion_profile?: MotionProfile;
  motion_profile_summary?: string;
}

const costOf = (b: BackendRow): number | null => {
  const raw = (b.options || {}).cost_usd;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** The model this one is actually set to run, named the way its maker names it. */
function modelInUse(b: BackendRow, models: MotionModel[],
                    fallbackKey?: string): string {
  const ref = String((b.options || {}).model || b.motion_profile?.model || "");
  const named = (r: string) =>
    models.find((m) => m.key === r || m.id === r)?.label || r;
  if (ref) return named(ref);
  if (b.lanes.includes("motion") && fallbackKey) {
    return `${named(fallbackKey)} (the default)`;
  }
  return "";
}

// ------------------------------------------------------------------ health

/**
 * Reachability, asked for after the page is on screen rather than baked into the
 * backends payload: one probe per card, so a box that is off keeps its own card grey
 * instead of holding up everything else.
 */
function HealthDot({ id }: { id: string }) {
  const [state, setState] = useState<"asking" | "up" | "down">("asking");
  const [note, setNote] = useState("");
  useEffect(() => {
    let alive = true;
    api(`/api/backends/${id}/health`)
      .then((h: any) => {
        if (!alive) return;
        setState(h?.up ? "up" : "down");
        setNote(String(h?.note || h?.error || ""));
      })
      .catch((e: any) => {
        if (!alive) return;
        setState("down");
        setNote(String(e?.message || ""));
      });
    return () => { alive = false; };
  }, [id]);
  const label = state === "asking" ? "checking"
    : state === "up" ? "answering" : "not answering";
  return (
    <span className="chip" title={note || undefined}>
      <span className={`dot ${state === "asking" ? "busy"
        : state === "up" ? "ok" : "bad"}`} />
      {label}
    </span>
  );
}

// ------------------------------------------------------------------ motion models

/** The choice a motion shot has: what each model costs, and what it is for. */
function MotionModels({ models, fallbackKey }:
                      { models: MotionModel[]; fallbackKey?: string }) {
  if (!models.length) return null;
  const named = (r?: string) =>
    models.find((m) => m.key === r || m.id === r)?.label || r || "";
  return (
    <div style={{ marginTop: 10, overflowX: "auto" }}>
      <div className="muted small" style={{ marginBottom: 4 }}>
        Clips can be made by either of these. The studio picks per shot.
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Model</th><th>Price</th><th>Clip length</th>
            <th>Good at</th><th>Watch for</th><th>Falls back to</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.key}>
              <td>
                {m.label}
                {m.key === fallbackKey && <span className="badge"
                  style={{ marginLeft: 6 }}>default</span>}
              </td>
              <td>{priceOf(m)}</td>
              <td>up to {m.seconds_max ?? 5}s</td>
              <td title={(m.strengths || []).join("; ")}>
                {(m.registers || []).map((r) => REGISTER_COPY[r] || r)
                  .join(", ") || "general shots"}
              </td>
              {/* What this model does to a plate that never asked for it —
                  the same line the motion tools relay when a clip is made. */}
              <td className="muted small">{m.drift || "—"}</td>
              <td>{named(m.fallback) || "nothing"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ a backend

/** The read-only half of a card: what this thing is, and what it costs to use. */
function BackendFacts({ b, models, fallbackKey }:
                      { b: BackendRow; models: MotionModel[];
                        fallbackKey?: string }) {
  const cost = costOf(b);
  const model = modelInUse(b, models, fallbackKey);
  return (
    <>
      <dl className="kv" style={{ marginTop: 8 }}>
        <dt>Does</dt>
        <dd>{b.lanes.map((l) => LANE_COPY[l]?.line || l).join(" ") ||
             "Nothing on its own."}</dd>
        {model && <><dt>Model</dt><dd>{model}</dd></>}
        <dt>Cost</dt>
        <dd>
          {cost === null ? "not priced"
            : cost > 0 ? `about ${money(cost)} each time it runs`
            : "free: it runs on our own machine"}
        </dd>
        {b.motion_profile_summary &&
          <><dt>Clips</dt><dd>{b.motion_profile_summary}</dd></>}
      </dl>
      {b.lanes.includes("motion") &&
        <MotionModels models={models} fallbackKey={fallbackKey} />}
    </>
  );
}

function BackendCard({ b, admin, models, fallbackKey, onSaved }:
                     { b: BackendRow; admin: boolean; models: MotionModel[];
                       fallbackKey?: string; onSaved: () => void }) {
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
          {b.lanes.map((l) => <span key={l} className="badge motion">
            {laneTitle(l)}</span>)}
          {admin && b.api_key_set && <span className="badge keeper">key set</span>}
        </div>
        <div className="row">
          {b.enabled ? <HealthDot id={b.id} />
            : <span className="chip">switched off</span>}
          {admin && <>
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
          </>}
        </div>
      </div>

      <BackendFacts b={b} models={models} fallbackKey={fallbackKey} />

      {admin && health && (
        <div className={health.up ? "ok" : "error"}>
          {JSON.stringify(health)}
        </div>
      )}
      {admin && edit && (
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

// ------------------------------------------------------------------ lane defaults

/** Which backend (and model) each generative lane uses for the CURRENT project.
 * The Shot Editor's model picker shows this as "(project default)"; this is where
 * it is set, and what the agent's `set_lane_default` tool drives. A viewer reads
 * the same table without the controls. */
function LaneDefaults({ pid, admin, backends, motion }:
                      { pid: string | null; admin: boolean;
                        backends: BackendRow[]; motion: MotionModel[] }) {
  const { data: lanes } = usePoll<Record<string, any[]>>(
    admin ? "/api/lanes" : null, 0);
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

  // A viewer only ever sees what is switched on, so the choices come from the
  // enabled rows rather than the full registry.
  const serving = (lane: string) =>
    (admin ? (lanes?.[lane] || [])
           : backends.filter((b) => b.lanes.includes(lane) && b.enabled));
  const nameOf = (id?: string | null) =>
    backends.find((b) => b.id === id)?.label || id || "";
  // "wan" is a registry key, not a name anyone would recognise on a page.
  const modelName = (ref?: string | null) =>
    motion.find((m) => m.key === ref || m.id === ref)?.label || ref || "";

  return (
    <>
      <h3>Where each part of the film is made</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>
        Project <b>{pid}</b>. This is the route a job takes when nobody names
        something else.
      </div>
      {error && <div className="error">{error}</div>}
      {LANES.filter((l) => serving(l).length > 0).map((lane) => {
        const cur = defaults[lane] || { backend: null, model: null };
        const first = serving(lane)[0];
        return (
          <div className="row" key={lane} style={{ marginBottom: 4 }}
               data-action={ANCHORS.settingsLane} data-lane={lane}>
            <span className="badge motion" style={{ minWidth: 74 }}>
              {laneTitle(lane)}</span>
            {admin ? <>
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
                     onChange={(e) =>
                       setModels({ ...models, [lane]: e.target.value })} />
              <button className="small" disabled={busy}
                      data-action={ANCHORS.settingsLaneSave} data-lane={lane}
                      onClick={() => run(
                        () => api(`/api/projects/${pid}/lanes`,
                                  { lane, backend: cur.backend,
                                    model: models[lane] ?? cur.model ?? null }), load)}>
                save</button>
            </> : (
              <span className="small">
                {nameOf(cur.backend) || (first?.label || first?.id || "")}
                {cur.model &&
                  <span className="muted"> · {modelName(cur.model)}</span>}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------ style + money

/** The house look, as data. Every still the project makes carries it. */
function StyleRegister({ pid }: { pid: string | null }) {
  const { data } = usePoll<any>(pid ? `/api/projects/${pid}/style` : null, 0);
  const style = data?.style;
  if (!style) return null;
  return (
    <>
      <h3>The look</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>
        One register, written once, added to every still the film draws. It is
        why the shots match.
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Name</dt><dd>{style.name}</dd>
          {style.prefix && <><dt>Every prompt starts</dt>
            <dd>{style.prefix}</dd></>}
          {style.avoid && <><dt>Never</dt><dd>{style.avoid}</dd></>}
        </dl>
      </div>
    </>
  );
}

/** What the studio has spent, and the ceiling it stops at. */
function Budget({ pid, budget }: { pid: string | null;
                                   budget?: { spent?: number; limit?: number } }) {
  const { data: spend } = usePoll<any>(pid ? `/api/projects/${pid}/spend` : null, 0);
  const spent = Number(budget?.spent ?? 0);
  const limit = Number(budget?.limit ?? 0);
  const lanes = Object.entries((spend?.by_lane || {}) as
    Record<string, { usd: number; calls: number }>);
  return (
    <>
      <h3>What it costs</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>
        Every paid call is written down as it happens. When the day's total
        reaches the limit the studio stops spending.
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Spent in the last day</dt>
          <dd>{money(spent)}{limit > 0 && ` of ${money(limit)}`}</dd>
          {spend?.takes > 0 && <><dt>This project, all time</dt>
            <dd>{money(Number(spend.total_usd || 0))} across{" "}
              {spend.takes} paid calls</dd></>}
          {lanes.length > 0 && <><dt>By part</dt>
            <dd>{lanes.map(([lane, v]) =>
              `${laneTitle(lane)} ${money(v.usd)}`).join(" · ")}</dd></>}
        </dl>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ the page

/** The project this page describes: the one last opened, else the first one. */
function useSettingsProject(): string | null {
  const remembered = currentProject();
  const { data: projects } = usePoll<Project[]>(
    remembered ? null : "/api/projects", 0);
  return remembered || projects?.[0]?.id || null;
}

export default function SettingsPage() {
  const { data: system } = usePoll<any>("/api/system", 0);
  const { data: backends, refresh } =
    usePoll<BackendRow[]>("/api/backends", 0);
  const { data: registry } = usePoll<any>("/api/motion-models", 0);
  const { data: types } = usePoll<any[]>("/api/backends/types", 0);
  const [adding, setAdding] = useState(false);
  const [nform, setNform] = useState({ id: "", type: "comfyui",
                                       base_url: "", api_key: "" });
  const [tok, setTok] = useState(getToken());
  const { busy, error, run } = useAsync();
  useEffect(() => { setTok(getToken()); }, []);

  // Unknown reads as viewer: a judge must never see a control that will 403.
  const admin = system?.role === "admin";
  const pid = useSettingsProject();
  const rows = backends || [];
  const models: MotionModel[] = (registry?.models || [])
    .filter((m: MotionModel) => m.enabled !== false);
  const fallbackKey: string | undefined = registry?.default;

  return (
    <div>
      <h2>{admin ? "Settings" : "What powers this studio"}</h2>

      <h3>The machines behind the film</h3>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Each part of a film is made by a different service, and each one is
        listed here with what it costs and whether it is answering right now.
        {admin && " Add your own GPU boxes or hosted APIs below."}
      </div>
      {rows.map((b) => (
        <BackendCard b={b} key={b.id} admin={admin} models={models}
                     fallbackKey={fallbackKey} onSaved={refresh} />
      ))}
      {!rows.length && <div className="muted small">Nothing is switched on.</div>}

      {admin && (adding ? (
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
      ))}

      <LaneDefaults pid={pid} admin={admin} backends={rows} motion={models} />
      <StyleRegister pid={pid} />
      <Budget pid={pid} budget={system?.budget} />

      <h3>Access link</h3>
      <div className="muted small">
        The studio is invite-only. Your access link stores a token in this
        browser; paste a token here if you were given one instead.
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input type="password" value={tok} data-action={ANCHORS.settingsToken}
               aria-label="Access token"
               onChange={(e) => setTok(e.target.value)} />
        <button data-action={ANCHORS.settingsTokenSave}
                onClick={() => { setToken(tok); location.reload(); }}>
          save</button>
      </div>
    </div>
  );
}
