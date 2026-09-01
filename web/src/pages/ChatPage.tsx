import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, sse } from "../api";
import { usePoll } from "../hooks";

interface Msg { role: string; text: string; provider?: string }

export default function ChatPage() {
  const { pid } = useParams() as { pid: string };
  const [params] = useSearchParams();
  const shot = params.get("shot") || undefined;
  const { data: lanes } = usePoll<any>("/api/lanes", 0);
  const providers = (lanes?.direction || []).filter((b: any) => b.enabled);
  const [provider, setProvider] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api(`/api/projects/${pid}/chat/history`).then((h: any[]) =>
      setMsgs(h.map((m) => ({ role: m.role, text: m.text,
                              provider: m.provider })))).catch(() => {});
  }, [pid]);
  useEffect(() => {
    boxRef.current?.scrollTo(0, boxRef.current.scrollHeight);
  }, [msgs]);

  const send = async () => {
    const message = input.trim();
    if (!message || streaming) return;
    setInput("");
    setMsgs((m) => [...m, { role: "director", text: message }]);
    setStreaming(true);
    let acc = "";
    try {
      await sse(`/api/projects/${pid}/chat`,
                { message, provider: provider || undefined, shot },
                (ev) => {
        if (ev.kind === "text") {
          acc += (acc ? "\n" : "") + ev.text;
          setMsgs((m) => {
            const last = m[m.length - 1];
            if (last?.role === "assistant-live") {
              return [...m.slice(0, -1), { role: "assistant-live", text: acc }];
            }
            return [...m, { role: "assistant-live", text: acc }];
          });
        } else if (ev.kind === "tool") {
          setMsgs((m) => [...m, { role: "tool", text: `🔧 ${ev.text}` }]);
        } else if (ev.kind === "plan") {
          setMsgs((m) => [...m, { role: "tool", text: `📋 plan: ${ev.text}` }]);
        } else if (ev.kind === "error") {
          setMsgs((m) => [...m, { role: "tool", text: `⚠ ${ev.text}` }]);
        }
      });
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "tool", text: `⚠ ${e.message}` }]);
    } finally {
      setStreaming(false);
      setMsgs((m) => m.map((x) => x.role === "assistant-live"
        ? { ...x, role: "assistant" } : x));
    }
  };

  return (
    <div className="chat">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Director chat</h2>
        {shot && <span className="chip">scoped to {shot}</span>}
        <div style={{ flex: 1 }} />
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">auto provider</option>
          {providers.map((p: any) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
      <div className="msgs" ref={boxRef}>
        {msgs.length === 0 && (
          <div className="muted">
            The line to the machines. “Keep the first second of the dial shot
            and freeze the rest.” · “Cut the film, act 2.” · “Reroll the
            background of the dial comp warmer.” Simple edits compile through
            the deterministic grammar; richer direction uses your configured
            Claude/LLM backend, which can inspect the film and run plans.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role === "director" ? "director"
            : m.role === "tool" ? "tool" : "assistant"}`}>
            {m.text}
          </div>
        ))}
        {streaming && <div className="msg tool">…</div>}
      </div>
      <div className="row">
        <textarea style={{ flex: 1, minHeight: 44 }} value={input}
                  placeholder="direct the film…"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault(); send();
                    }
                  }} />
        <button className="primary" onClick={send}
                disabled={streaming || !input.trim()}>send</button>
      </div>
    </div>
  );
}
