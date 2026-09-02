import React from "react";
import ReactDOM from "react-dom/client";
import { Navigate, RouterProvider, createBrowserRouter, useLocation } from "react-router-dom";
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
import { APP_BASE, LEGACY_APP_PATHS } from "./routes";
import "./styles.css";

/**
 * Deep links minted before the studio moved to `/app` still land: same path under the
 * new base, query string and hash intact, so `?token=…` and `?tab=motion` survive.
 */
function LegacyRedirect() {
  const loc = useLocation();
  return <Navigate replace to={`${APP_BASE}${loc.pathname}${loc.search}${loc.hash}`} />;
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
      { path: "p/:pid", element: <FilmEditorPage /> },
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
