import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import App from "./App";
import ChatPage from "./pages/ChatPage";
import ComposerPage from "./pages/ComposerPage";
import FilmEditorPage from "./pages/FilmEditorPage";
import JobsPage from "./pages/JobsPage";
import ProjectsPage from "./pages/ProjectsPage";
import SettingsPage from "./pages/SettingsPage";
import ShotPage from "./pages/ShotPage";
import TimelinePage from "./pages/TimelinePage";
import "./styles.css";

const router = createBrowserRouter([
  {
    path: "/",
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
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
