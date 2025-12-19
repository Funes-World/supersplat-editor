import { Events } from "./events";

const loadConfig = async (url: URL,events: Events) => {
  const mode = (url.searchParams.get("mode") || "").toLowerCase();
  if (mode === "viewer") {
    await loadViewerConfig(events);
    return "viewer";
  }
  await loadEditorConfig(events);
  return "editor";
};

const loadViewerConfig = async (events: Events) => {
  events.fire("grid.setVisible", false);
  events.fire("camera.toggleOverlay");
  events.fire("bottomToolbar.setVisible", false);
  events.fire("rightToolbar.setVisible", false);
  events.fire("modeToggle.setVisible", false);
  events.fire("menuBar.setVisible", false);
  events.fire("appLabel.setVisible", false);
  events.fire("viewCube.setVisible", false);
  events.fire("timelinePanel.setVisible", false);
  events.fire("dataPanel.setVisible", false);
  events.fire("scenePanel.setVisible", false);
};

const loadEditorConfig = async (events: Events) => {
  events.fire("camera.toggleOverlay");
  events.fire("menuBar.setVisible", false);
  events.fire("timelinePanel.setVisible", false);
  events.fire("dataPanel.setVisible", false);
  // events.fire("scenePanel.setVisible", false);
  events.fire("rightToolbar.setVisible", false);
  events.fire("appLabel.setVisible", false);
  events.fire("modeToggle.setVisible", false);
};

export { loadConfig };
