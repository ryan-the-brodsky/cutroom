import { useState } from "react";
import { Link } from "react-router-dom";
import { ANCHORS } from "../agent/contract";
import { api } from "../api";
import { pushToast, useAsync, usePoll } from "../hooks";
import type { Project } from "../types";

export default function ProjectsPage() {
  const { data: projects, refresh } = usePoll<Project[]>("/api/projects", 8000);
  const { busy, error, run } = useAsync();
  const [nid, setNid] = useState("");
  const [importSrc, setImportSrc] = useState("");
  const [importId, setImportId] = useState("");

  return (
    <div>
      <h2>Projects</h2>
      <div className="grid cards">
        {(projects || []).map((p) => (
          <Link to={`/p/${p.id}`} key={p.id} className="card"
                data-action={ANCHORS.projectsCard} data-pid={p.id}>
            <h4>{p.label || p.id}</h4>
            <div className="muted">{p.shots} shots{p.paused ? " · ⏸" : ""}</div>
          </Link>
        ))}
      </div>

      <h3>New empty project</h3>
      <div className="row">
        <input placeholder="slug (e.g. next-year)" value={nid}
               data-action={ANCHORS.projectsNewId}
               onChange={(e) => setNid(e.target.value)} />
        <button className="primary" disabled={busy || !nid}
          data-action={ANCHORS.projectsCreate}
          onClick={() => run(() => api("/api/projects", { id: nid }),
                             () => { setNid(""); refresh(); })}>
          create
        </button>
      </div>

      <h3>Import an existing production repo</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>
        Points at a studio folder (prompts/shots.jsonl, renders/, audio/).
        Media is copied; shots, keepers, overrides, comps and takes are
        indexed. Runs as a job.
      </div>
      <div className="row">
        <input style={{ width: 340 }}
               placeholder="/path/to/repo" value={importSrc}
               data-action={ANCHORS.projectsImportSrc}
               onChange={(e) => setImportSrc(e.target.value)} />
        <input placeholder="project slug" value={importId}
               data-action={ANCHORS.projectsImportId}
               onChange={(e) => setImportId(e.target.value)} />
        <button className="primary" disabled={busy || !importSrc || !importId}
          data-action={ANCHORS.projectsImport}
          onClick={() => run(
            () => api(`/api/projects/${importId}/import`,
                      { src_root: importSrc }),
            (d: any) => {
              pushToast({ text: "import started", job: d.job });
              refresh();
            })}>
          import
        </button>
      </div>
      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
