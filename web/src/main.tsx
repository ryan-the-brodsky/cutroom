import React from "react";
import ReactDOM from "react-dom/client";
import {
  Navigate, RouterProvider, createBrowserRouter, useLocation, useParams,
} from "react-router-dom";
import { installAgentLayer } from "./agent";
import App from "./App";
import LandingPage from "./pages/LandingPage";
import ChatPage from "./pages/ChatPage";
import ComposerPage from "./pages/ComposerPage";
import FilmEditorPage from "./pages/FilmEditorPage";
import JobsPage from "./pages/JobsPage";
import ProjectsPage from "./pages/ProjectsPage";
import SettingsPage from "./pages/SettingsPage";
import ShotPage from "./pages/ShotPage";
import TimelinePage from "./pages/TimelinePage";
import { APP_BASE, LEGACY_APP_PATHS, timelinePath } from "./routes";
import "./styles.css";

/**
 * Deep links minted before the studio moved to `/app` still land: same path under the
 * new base, query string and hash intact, so `?token=…` and `?tab=motion` survive.
 */
function LegacyRedirect() {
  const loc = useLocation();
  return <Navigate replace to={`${APP_BASE}${loc.pathname}${loc.search}${loc.hash}`} />;
}

/**
 * The project root is a doorway, not a page: opening a film lands on the TIMELINE — the
 * film as it actually plays — and the Film Editor keeps its own path (`…/p/:pid/film`),
 * reachable from the sidebar and from every tool that asks for the board by name.
 * `replace` so the back button leaves the project instead of bouncing off the redirect.
 */
function ProjectHome() {
  const { pid } = useParams();
  const loc = useLocation();
  const to = `${timelinePath(encodeURIComponent(pid || ""))}${loc.search}${loc.hash}`;
  return <Navigate replace to={to} />;
}

const router = createBrowserRouter([
  { path: "/", element: <LandingPage /> },
  {
    path: APP_BASE,
    element: <App />,
    children: [
      { index: true, element: <ProjectsPage /> },
      { path: "jobs", element: <JobsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "p/:pid", element: <ProjectHome /> },
      { path: "p/:pid/film", element: <FilmEditorPage /> },
      { path: "p/:pid/shot/:sid", element: <ShotPage /> },
      { path: "p/:pid/comp/:cid", element: <ComposerPage /> },
      { path: "p/:pid/timeline", element: <TimelinePage /> },
      { path: "p/:pid/chat", element: <ChatPage /> },
    ],
  },
  ...LEGACY_APP_PATHS.map((path) => ({ path, element: <LegacyRedirect /> })),
]);

// One registry → WebMCP tools + the ⌘K palette + "show me" (docs/WEBMCP-PLAN.md §3).
// Installed once, app-level, against the real router so tools can navigate the UI.
// It runs on `/` too: a judge who lands on the public page and asks "what can this do"
// gets the whole catalogue, and the first tool call walks itself into /app.
void installAgentLayer(router);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
