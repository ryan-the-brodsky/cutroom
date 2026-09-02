import { useEffect, useState } from "react";
import { ApiError, api, getToken, setToken } from "../api";
import { usePublicConfig } from "../publicConfig";

/**
 * The studio is invite-only: one shared access token, delivered as `?token=` on a link
 * and kept in the browser. Without it every API call is a 401, which used to surface as
 * an empty shell and a raw error. This gate probes once and explains instead.
 *
 * It is also the end of the road for anyone who typed the URL without an invite, so it
 * carries the two ways forward a stranger has: the request-access form, and the film on
 * the front page, which needs no token at all. Both come from `/api/public` — the gate
 * renders before authentication, so it cannot use the authed `api()` for them.
 */
export default function AccessGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "locked">(getToken() ? "checking" : "locked");
  const [draft, setDraft] = useState("");
  const pub = usePublicConfig();

  useEffect(() => {
    if (state !== "checking") return;
    let alive = true;
    api("/api/system")
      .then(() => { if (alive) setState("ok"); })
      .catch((e: unknown) => {
        if (!alive) return;
        const status = e instanceof ApiError ? e.status : 0;
        setState(status === 401 || status === 403 ? "locked" : "ok");
      });
    return () => { alive = false; };
  }, [state]);

  if (state === "ok") return <>{children}</>;
  if (state === "checking") return <div className="gate" data-action="app.gate.checking" />;

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    setToken(t);
    window.location.reload();
  };
  return (
    <div className="gate" data-action="app.gate">
      <div className="gate-card">
        <img className="gate-mark" src="/genga-wordmark.svg" alt="Genga Studio" />
        <h1>This studio is invite-only.</h1>
        <p>
          Open the access link you were given and the studio unlocks in this browser.
          If you have the token itself, paste it here.
        </p>
        <form className="gate-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input
            type="password" autoComplete="off" placeholder="access token"
            value={draft} onChange={(e) => setDraft(e.target.value)}
            data-action="app.gate.token" aria-label="Access token" />
          <button type="submit" className="primary" data-action="app.gate.enter">Enter the studio</button>
        </form>
        {pub.access_form_url && (
          <p>
            No invite?{" "}
            <a href={pub.access_form_url} target="_blank" rel="noreferrer"
               data-action="app.gate.request">Request access</a>.{" "}
            Leave your email and what you would make with it, and you will get a link.
          </p>
        )}
        <p className="gate-foot">
          <a href="/">Watch the film on the front page</a> · no token needed
        </p>
      </div>
    </div>
  );
}
