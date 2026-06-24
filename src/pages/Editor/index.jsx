import React from "react";
import { createRoot } from "react-dom/client";
import Sandbox from "./Sandbox";

// Find the container to render into
const container = window.document.querySelector("#app-container");

if (container) {
  const root = createRoot(container);
  root.render(<Sandbox />);
}

// Hot Module Replacement
const hotModule =
  typeof module !== "undefined" && module ? module["hot"] : null;

if (hotModule && typeof hotModule["accept"] === "function") {
  hotModule["accept"]();
}
