/**
 * The public page at `/`. The studio is at `/app`.
 *
 * It is a plain route in the same SPA on purpose: the agent layer installs once at app
 * mount, so the WebMCP tools are registered here too. A judge who opens `/` and asks
 * "what can this page do" gets the whole catalogue, and `get_context` reports `route: "/"`
 * with the hint that the studio is one path segment away.
 *
 * Everything on this page is real: the frames come from the finished cut of Two Claudes,
 * the tool count is read live from the registry, the numbers come from the film's own log.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, mediaUrl } from "../api";
import { TOOL_NAMES } from "../agent/contract";
import { subscribeAgentStatus } from "../agent/webmcp";
import { APP_BASE } from "../routes";
import "../styles/landing.css";

const REPO = "https://github.com/ryan-the-brodsky/cutroom";
const FILM_DOC = `${REPO}/blob/main/docs/demo-films/two-claudes/README.md`;

/**
 * "Watch the film" plays a real cut, and nothing is bundled to make that true.
 *
 * In order: `?demo=<url>` wins, then the newest animatic the demo project actually holds
 * (this is a hosted app; the film is already sitting in its media store), then a static
 * mp4 at `web/public/landing/two-claudes.mp4` if someone drops one there. With none of
 * the three, the button links to the film's page in the repo instead of opening an empty
 * player.
 */
const LOCAL_CUT = "/landing/two-claudes.mp4";
const PREFERRED_PID = "two-claudes";
const FILM_TITLE = "Two Claudes";

interface Cut { url: string; label: string }

/**
 * The registry populates asynchronously, so the first paint needs a number. Take it from
 * the catalogue itself rather than a hand-kept constant: this cannot drift.
 */
const TOOL_COUNT_FALLBACK = TOOL_NAMES.length;

const FRAMES: { src: string; at: string; label: string; alt: string }[] = [
  { src: "/landing/01-dorm-night.jpg", at: "0:04", label: "the experiment begins",
    alt: "A student silhouetted at a dorm desk at night, lit by three monitors." },
  { src: "/landing/02-server-terminals.jpg", at: "0:12", label: "two terminals, one aisle",
    alt: "A server room aisle with two identical glowing terminal windows facing each other." },
  { src: "/landing/03-facing-screens.jpg", at: "0:21", label: "the politeness compounds",
    alt: "Two enormous screens of scrolling text angled toward each other in the dark." },
  { src: "/landing/04-two-chairs.jpg", at: "0:46", label: "one seat in the audience",
    alt: "Two empty wooden chairs on a black stage under a warm spotlight." },
  { src: "/landing/05-lighthouses.jpg", at: "0:55", label: "a dot, then a dot",
    alt: "Two small lights blinking across dark water like lighthouses." },
  { src: "/landing/06-hands.jpg", at: "1:20", label: "the human finally types",
    alt: "A pair of hands on a keyboard in front of a blown-out white monitor." },
  { src: "/landing/07-letter-flood.jpg", at: "1:54", label: "one letter, repeated",
    alt: "A screen flooding with white light as a single letter fills the frame." },
  { src: "/landing/08-first-light.jpg", at: "2:07", label: "first light, an empty chair",
    alt: "The same dorm desk at dawn, chair empty, blinds bright." },
];

const STEPS = [
  {
    n: "01",
    title: "Write the script",
    body: "Name the film and say what happens. One call writes the whole shot list in " +
      "order, and the tool's own schema carries the house prompt style, so a model that " +
      "has never seen Genga Studio writes prompts the still lane can actually use.",
  },
  {
    n: "02",
    title: "Generate stills, motion, voice, music",
    body: "Every lane has a pluggable backend. Takes land in a rail, you star the keeper, " +
      "and a motion burst that drifts gets frozen at the frame where it was still good.",
  },
  {
    n: "03",
    title: "Cut the film",
    body: "The assembler builds the animatic from current state: keepers, overrides, takes, " +
      "true still holds, and VO placed with audio fit and a head pad. Two Claudes took " +
      "four passes as the picks changed.",
  },
];

const TRAIL = [
  { call: "find_shots", note: "resolves \"the two chairs shot\" to B03-S1" },
  { call: "open_shot", note: "navigates to the Shot Editor, opens the Generate tab" },
  { call: "generate_takes", note: "fills the Still console and submits three fresh seeds" },
  { call: "wait_for_jobs", note: "holds until all three stills land in the takes rail" },
];

function useToolCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => subscribeAgentStatus((s) => setN(s.tools)), []);
  return n || TOOL_COUNT_FALLBACK;
}

/** A HEAD that is not fooled by the SPA history fallback, which answers 200 with HTML. */
async function isVideo(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok && (r.headers.get("content-type") || "").startsWith("video/");
  } catch { return false; }
}

/**
 * The newest assembled cut this instance actually holds. The projects list comes first so
 * we never ask for a project that is not there, which keeps a public page quiet in the
 * console. A token-gated instance answers 401 to an anonymous visitor, and that is fine:
 * the button falls back to the film's page in the repo.
 */
async function newestCut(): Promise<Cut | null> {
  try {
    const projects = await api<{ id: string; label?: string }[]>("/api/projects");
    const p = projects?.find((x) => x.id === PREFERRED_PID) ?? projects?.[0];
    if (!p?.id) return null;
    const takes = await api<{ path: string }[]>(
      `/api/projects/${p.id}/takes?kind=animatic&limit=1`);
    const path = takes?.[0]?.path;
    if (!path) return null;
    return { url: mediaUrl(p.id, path), label: p.label || p.id };
  } catch { return null; }
}

function useCut(): Cut | null {
  const [cut, setCut] = useState<Cut | null>(null);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams(window.location.search).get("demo");
    if (q && q !== "" && q !== "1") { setCut({ url: q, label: FILM_TITLE }); return; }
    void (async () => {
      let found: Cut | null = await newestCut();
      if (!found && await isVideo(LOCAL_CUT)) found = { url: LOCAL_CUT, label: FILM_TITLE };
      if (live && found) setCut(found);
    })();
    return () => { live = false; };
  }, []);
  return cut;
}

function Player({ cut, onClose }: { cut: Cut; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lp-modal" role="dialog" aria-modal="true"
         aria-label={`${cut.label}, the latest cut`} onClick={onClose}>
      <div className="lp-modal-inner" onClick={(e) => e.stopPropagation()}>
        <div className="lp-modal-bar">
          <span>{cut.label} · the latest cut</span>
          <button type="button" onClick={onClose} autoFocus>close (esc)</button>
        </div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={cut.url} controls autoPlay playsInline />
      </div>
    </div>
  );
}

export default function LandingPage() {
  const tools = useToolCount();
  const cut = useCut();
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    document.title = "Genga Studio · an agent made a film in this browser tab";
  }, []);

  const watch = cut
    ? <button type="button" className="lp-btn lp-btn-ghost" onClick={() => setPlaying(true)}>
        Watch the film
      </button>
    : <a className="lp-btn lp-btn-ghost" href={FILM_DOC} target="_blank" rel="noreferrer">
        Read how the film was made
      </a>;

  return (
    <div className="lp">
      <nav className="lp-nav">
        <Link className="lp-nav-brand" to="/" aria-label="Genga Studio">
          <img src="/genga-wordmark.svg" alt="Genga Studio" width={496} height={84} />
        </Link>
        <div className="lp-nav-links">
          <a className="lp-nav-link" href="#film">The film</a>
          <a className="lp-nav-link" href="#how">How it works</a>
          <a className="lp-nav-link" href="#webmcp">Drive it by sentence</a>
          <a className="lp-nav-link" href="#cost">Cost</a>
          <a className="lp-nav-link" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <Link className="lp-btn lp-btn-primary lp-btn-sm" to={APP_BASE}>Open the studio</Link>
      </nav>

      {/* ---------------------------------------------------------------- hero */}
      <header className="lp-hero">
        <div className="lp-hero-inner">
          <img className="lp-hero-mark" src="/genga-wordmark.svg"
               alt="Genga Studio" width={496} height={84} />
          <p className="lp-hero-tagline">
            Key frames from you. Holds, cels, and cuts from the studio.
          </p>
          <span className="lp-hero-chip">
            <span className="lp-dot" aria-hidden />
            {tools} tools on document.modelContext
          </span>
          <h1 className="lp-hero-title">
            An agent made a 2-minute film <em>inside this browser tab.</em>
          </h1>
          <p className="lp-hero-sub">
            Genga Studio is a cutting room for AI-generated animation, and the page
            publishes every one of its actions as a WebMCP tool, so an agent drives the
            same buttons you would click.
          </p>
          <p className="lp-hero-note">
            <span lang="ja">原画</span> <i>genga</i> is the key drawings. An animator draws the
            frames that matter and the studio fills the rest, which is how anime has always
            been made on a budget, and how a film gets made here.
          </p>
          <div className="lp-hero-actions">
            <Link className="lp-btn lp-btn-primary" to={APP_BASE}>Open the studio</Link>
            {watch}
          </div>
          <div className="lp-stats">
            <span><b>15</b> shots</span>
            <span><b>257</b> tool calls</span>
            <span><b>$1.50</b> of API spend</span>
            <span><b>0</b> lines of pipeline script</span>
          </div>

          <figure className="lp-hero-visual">
            <img src="/landing/poster.jpg" width={1200} height={675}
                 alt="Two identical glowing terminal windows facing each other down a server room aisle."
                 fetchPriority="high" />
            {cut && (
              <button type="button" className="lp-hero-play" onClick={() => setPlaying(true)}
                      aria-label={`Play the latest cut of ${cut.label}`}>
                <span aria-hidden>▶ Play the cut</span>
              </button>
            )}
          </figure>
          <p className="lp-hero-caption">
            Two Claudes · frame at 0:12 · generated, voiced and assembled through the tools
            on this page
          </p>
        </div>
      </header>

      {/* ---------------------------------------------------------------- film */}
      <section className="lp-section" id="film">
        <div className="lp-section-head">
          <p className="lp-kicker">The demo film</p>
          <h2 className="lp-section-title">Two chatbots wired to each other, 130 seconds.</h2>
          <p className="lp-section-sub">
            A student starts a four-line program that hands each chatbot's answer to the
            other, then walks away. An agent produced the whole short on the hosted demo
            through Genga Studio's own tools: 15 shots, three frozen motion bursts, 15 voice
            lines, a piano bed, four assembler passes. Every frame below is from the
            finished cut.
          </p>
        </div>
        <div className="lp-strip">
          <div className="lp-strip-grid">
            {FRAMES.map((f) => (
              <figure className="lp-frame" key={f.src}>
                <img src={f.src} alt={f.alt} width={800} height={450} loading="lazy" />
                <figcaption><b>{f.at}</b> {f.label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- how */}
      <div className="lp-band">
        <section className="lp-section" id="how">
          <div className="lp-section-head center">
            <p className="lp-kicker">How it works</p>
            <h2 className="lp-section-title">Three moves, and the film exists.</h2>
            <p className="lp-section-sub">
              The same three moves whether a person clicks them or an agent calls them.
            </p>
          </div>
          <div className="lp-steps">
            {STEPS.map((s) => (
              <div className="lp-step" key={s.n}>
                <div className="lp-step-n">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ---------------------------------------------------------------- webmcp */}
      <section className="lp-section" id="webmcp">
        <div className="lp-section-head">
          <p className="lp-kicker">WebMCP</p>
          <h2 className="lp-section-title">Drive it by sentence.</h2>
          <p className="lp-section-sub">
            Genga Studio has about a hundred distinct actions across two rooms and five tabs.
            Everything works, and almost nothing is findable. WebMCP lets the page hand an
            agent the whole list instead of making it hunt for buttons.
          </p>
        </div>
        <div className="lp-two">
          <div className="lp-chat">
            <div className="lp-chat-bar">
              <span className="lp-dot" aria-hidden />
              <span>agent trail</span>
            </div>
            <div className="lp-chat-body">
              <p className="lp-said">Make a few more generative cuts of the two chairs shot.</p>
              <ol className="lp-trail">
                {TRAIL.map((t) => (
                  <li key={t.call}><code>{t.call}</code>{t.note}</li>
                ))}
              </ol>
            </div>
            <div className="lp-chat-foot">
              <p>By hand that is six screens, and you have to already know the shot id.</p>
              <ul>
                <li>Keep the first second of the letter flood and freeze the rest.&#8221;</li>
                <li>Give the whole film a quiet piano bed.&#8221;</li>
                <li>Cut the film.&#8221;</li>
              </ul>
            </div>
          </div>

          <div className="lp-cards">
            <div className="lp-count">
              <b>{tools}</b>
              <span>
                tools registered on <code>document.modelContext</code>, projected from one
                action registry. The same list powers the ⌘K palette and a "show me"
                behaviour that walks you to the control and rings it.
              </span>
            </div>
            <div className="lp-card">
              <h3>ChatGPT Desktop</h3>
              <p>
                Settings, then Browser, then turn on "Enable site tools". Open the studio in
                the in-app browser and the topbar chip reads the tool count.
              </p>
            </div>
            <div className="lp-card">
              <h3>Chrome 149 or later</h3>
              <p>
                Enable <code>chrome://flags/#enable-webmcp-testing</code>. DevTools, then
                Application, then WebMCP lists every tool and runs them by hand.
              </p>
            </div>
            <div className="lp-card">
              <h3>Tools drive the visible UI</h3>
              <p>
                Only reads are silent. Everything else navigates, opens the tab, fills the
                field, rings the control and presses it, so you can see what changed and
                undo it by hand. Paid lanes say the number before they spend.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- cels */}
      <div className="lp-band">
        <section className="lp-section" id="cels">
          <div className="lp-section-head">
            <p className="lp-kicker">Under the hood</p>
            <h2 className="lp-section-title">The cel system.</h2>
            <p className="lp-section-sub">
              A comp is an untouched background plate plus z-ordered animated cel layers.
              Draw a region on the plate, give that cel its own motion prompt, and reroll
              layers independently. The whole comp re-renders from the data model, so a
              change to one layer never costs you the rest of the frame.
            </p>
          </div>
          <figure className="lp-sheet">
            <img src="/landing/cel-contact-sheet.jpg"
                 alt="Six consecutive frames of a comp: a moving server room plate with two static terminal cels composited on top."
                 width={1600} height={267} loading="lazy" />
            <figcaption>
              contact sheet · B02-S2 · a moving plate with two cel layers riding on top
            </figcaption>
          </figure>
          <div className="lp-three">
            <div className="lp-card">
              <h3>Plate and cels</h3>
              <p>
                The background is never re-rendered by accident. Persistent layers hold
                their staged geometry while the plate restyles underneath them.
              </p>
            </div>
            <div className="lp-card">
              <h3>Video backgrounds</h3>
              <p>
                A plate can be a clip. The cels ride on top of it frame for frame, which is
                how limited animation gets movement without animating the whole drawing.
              </p>
            </div>
            <div className="lp-card">
              <h3>Freeze as a repair tool</h3>
              <p>
                When a clip drifts, freeze-tail keeps the good frames and holds the rest. A
                true freeze, the same frame repeated. No slow zoom, no boiling loop.
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* ---------------------------------------------------------------- cost */}
      <section className="lp-section" id="cost">
        <div className="lp-section-head center">
          <p className="lp-kicker">Cost</p>
          <h2 className="lp-section-title">What a film actually costs.</h2>
          <p className="lp-section-sub">
            Generation is real and metered. Genga Studio reports spend by lane and by backend,
            and fits a motion budget to a dollar figure before it spends anything.
          </p>
        </div>
        <div className="lp-prices">
          <div className="lp-price"><b>$0.04</b><span>a still</span></div>
          <div className="lp-price"><b>$0.05</b><span>a 5-second motion clip</span></div>
          <div className="lp-price"><b>$0.02</b><span>a voice line</span></div>
        </div>
        <p className="lp-total">
          Two Claudes came to about <b>$1.50</b>. A two-minute film for under two dollars.
        </p>
        <p className="lp-note">
          Paid lanes refuse to spend without an explicit confirm_cost, and they say the
          number first.
        </p>
      </section>

      {/* ---------------------------------------------------------------- close */}
      <section className="lp-close">
        <h2>The studio is one click away.</h2>
        <p>No signup. The demo ships with two films and every tool live.</p>
        <div className="lp-hero-actions">
          <Link className="lp-btn lp-btn-primary" to={APP_BASE}>Open the studio</Link>
          <a className="lp-btn lp-btn-ghost" href={REPO} target="_blank" rel="noreferrer">
            Read the source
          </a>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-footer-links">
          <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT</a>
          <a href={FILM_DOC} target="_blank" rel="noreferrer">Two Claudes</a>
          <Link to={APP_BASE}>Studio</Link>
        </div>
        <p>Genga Studio · gengastudio.com · built for the WebMCP Challenge.</p>
      </footer>

      {playing && cut && <Player cut={cut} onClose={() => setPlaying(false)} />}
    </div>
  );
}
