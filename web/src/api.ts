const BASE = (import.meta as any).env?.VITE_API_BASE || "";

let TOKEN = localStorage.getItem("cutroom_token") || "";
export function setToken(t: string) {
  TOKEN = t;
  localStorage.setItem("cutroom_token", t);
}
export function getToken() {
  return TOKEN;
}

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
  return h;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

export async function api<T = any>(path: string, body?: any,
                                   method?: string): Promise<T> {
  const r = await fetch(BASE + path, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const d = await r.json();
      detail = typeof d.detail === "string" ? d.detail : JSON.stringify(d);
    } catch { /* keep statusText */ }
    throw new ApiError(r.status, detail);
  }
  return r.json();
}

export async function upload(pid: string, file: File, opts: {
  dir?: string; shot?: string; kind?: string;
} = {}): Promise<{ rel: string }> {
  const q = new URLSearchParams({
    filename: file.name, dir: opts.dir || "uploads",
    kind: opts.kind || "ref", ...(opts.shot ? { shot: opts.shot } : {}),
  });
  const r = await fetch(`${BASE}/api/projects/${pid}/upload?${q}`, {
    method: "POST", headers: headers(false), body: file,
  });
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r.json();
}

const tok = () => (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
export const mediaUrl = (pid: string, rel: string) =>
  `${BASE}/api/projects/${pid}/media/${rel}${tok()}`;
export const thumbUrl = (pid: string, rel: string, w = 320) =>
  `${BASE}/api/projects/${pid}/thumb/${rel}${tok()}${TOKEN ? "&" : "?"}w=${w}`;

export type SSEEvent = { kind: string; text?: string; status?: string;
                         result?: any; error?: string };

export async function sse(path: string, body: any,
                          onEvent: (ev: SSEEvent) => void,
                          signal?: AbortSignal): Promise<void> {
  const r = await fetch(BASE + path, {
    method: body !== undefined ? "POST" : "GET",
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!r.ok || !r.body) throw new ApiError(r.status, await r.text());
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ }
    }
  }
}
