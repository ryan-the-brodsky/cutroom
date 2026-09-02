/**
 * One base, one set of builders. `/` is the public landing page; the studio lives
 * under `/app`.
 *
 * Everything that builds a URL — the router, the sidebar, `shotUrl`/`filmUrl`, every
 * `where.route` in the registry, the e2e helper, the driver script — goes through here,
 * so moving the app is a one-line change and a grep for a stray `"/p/"` is a real test.
 *
 * `LANDING` is deliberately NOT under APP_BASE: registry entries that live "anywhere"
 * (the ⌘K palette, get_context on the landing page) keep reporting `/`.
 *
 * The project ROOT (`/app/p/:pid`) is not a page: it redirects to the project's default
 * view, the Timeline. The Film Editor has its own explicit path (`/app/p/:pid/film`), so
 * a tool that wants the board asks for the board rather than for "the project".
 */
export const APP_BASE = "/app";
export const LANDING = "/";

/** `appPath()` → "/app" · `appPath("/jobs")` → "/app/jobs" · `appPath("p/x")` → "/app/p/x" */
export function appPath(sub = ""): string {
  if (!sub || sub === "/") return APP_BASE;
  return `${APP_BASE}${sub.startsWith("/") ? sub : `/${sub}`}`;
}

/** Route patterns, with `:pid` / `:sid` / `:cid` left unbound for `fillRoute`. */
export const ROUTES = {
  projects: APP_BASE,
  jobs: appPath("/jobs"),
  settings: appPath("/settings"),
  /** The project root — a redirect to `timeline`, never a page of its own. */
  project: appPath("/p/:pid"),
  film: appPath("/p/:pid/film"),
  shot: appPath("/p/:pid/shot/:sid"),
  comp: appPath("/p/:pid/comp/:cid"),
  timeline: appPath("/p/:pid/timeline"),
  chat: appPath("/p/:pid/chat"),
} as const;

/** Concrete paths. */
/** The project's front door. Redirects to `timelinePath` — link here to mean "open it". */
export const projectPath = (pid: string) => appPath(`/p/${pid}`);
export const filmPath = (pid: string) => appPath(`/p/${pid}/film`);
export const shotPath = (pid: string, sid: string) => appPath(`/p/${pid}/shot/${sid}`);
export const timelinePath = (pid: string) => appPath(`/p/${pid}/timeline`);
export const chatPath = (pid: string) => appPath(`/p/${pid}/chat`);

/** The `:pid` in a pathname, under the app base. Null on the landing page. */
export function pidFromPath(pathname: string): string | null {
  const m = pathname.match(new RegExp(`^${APP_BASE}/p/([^/]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Deep links minted before the app moved (`/p/…`, `/jobs`, `/settings`) still work:
 * the router mounts a `<Navigate>` for each of these, preserving the query string.
 */
export const LEGACY_APP_PATHS = [
  "jobs",
  "settings",
  "p/:pid",
  "p/:pid/film",
  "p/:pid/shot/:sid",
  "p/:pid/comp/:cid",
  "p/:pid/timeline",
  "p/:pid/chat",
] as const;
