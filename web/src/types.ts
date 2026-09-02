export interface Project {
  id: string; label: string; paused: boolean; created_at: number;
  shots: number;
}

export interface FilmEntry {
  sid: string; beat: string; act: number; type: string; register: string;
  seconds: number; scripted_seconds: number;
  image_prompt: string; negative: string;
  motion_prompt: string | null; pan: string | null;
  narration: string | null;
  /** @deprecated the pre-rename spelling of `narration`; server still sends it. */
  radio?: string | null;
  dialogue: { character: string; line: string }[];
  sfx: string | null; ambient: string | null; cut: string | null;
  render_notes: string | null;
  keeper: string | null; curation_note: string | null;
  override: Record<string, any>;
  /** The shot's reference images, {path, role, note?} (workstream S). */
  references?: { path: string; role: string; note?: string }[];
  stills: string[]; i2i: string[]; motion: string[]; crops: string[];
  fx: string[]; vo: string[];
  active_source: string | null;
  takes?: Take[];
  comps?: CompSummary[];
}

export interface Take {
  id: number; kind: string; path: string; shot?: string | null;
  seed: number | null; backend: string | null; model: string | null;
  prompt: string | null; params: Record<string, any>; sources: string[];
  created_at: number; meta: Record<string, any>;
}

export interface CompSummary {
  cid: string; shot?: string | null; background: string;
  /** A comp background may be a still plate or a clip (both stream). */
  background_kind?: "still" | "video";
  width: number; height: number; duration: number;
  layers: CompLayer[]; background_history?: string[];
}

export interface CompLayer {
  id: string; clip: string | null; region: number[]; feather?: number;
  matte?: string; prompt?: string; frames?: number; steps?: number;
  cfg?: number; media?: Record<string, any>; opacity?: number; z?: number;
  variants?: { clip: string; prompt?: string }[];
  // separated-figure layers (gen.separate): the cel animates from the
  // ORIGINAL plate; mask/cutout document the separation
  source_plate?: string; mask?: string; cutout?: string;
}

export interface Job {
  id: string; project: string | null; type: string; pool: string;
  title: string; status: string; created_at: number;
  started_at: number | null; finished_at: number | null;
  result: Record<string, any>; error: string | null; worker: string | null;
}

export interface BackendInfo {
  id: string; type: string; label: string; base_url: string;
  enabled: boolean; options: Record<string, any>;
  api_key_set: boolean; api_key_hint: string; lanes: string[];
}

export interface PlanOp { op: string; [k: string]: any }
export interface Plan { ops: PlanOp[]; note: string }
