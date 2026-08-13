// Must be the first import; sets __webpack_public_path__ so dynamic
// chunks resolve against the extension origin. See publicPath.js.
import "./publicPath";

import React from "react";
import { createRoot } from "react-dom/client";
import Content from "./Content";

// Idempotency: content script is injected via manifest AND by
// executeScripts() on session start; both mounts would double-fire.
// The manifest runs this at document_start, when document.body may not exist yet.
const mountContent = () => {
  if (window.__screenityContentBootstrapped) return;

  const body = document.body;
  if (!body) return false;

  const existingRoot = document.getElementById("screenity-ui");
  if (existingRoot) {
    existingRoot.remove();
  }

  const root = document.createElement("div");
  root.id = "screenity-ui";
  body.appendChild(root);

  window.__screenityContentBootstrapped = true;
  const appRoot = createRoot(root);
  appRoot.render(<Content />);
  return true;
};

if (!mountContent()) {
  document.addEventListener("DOMContentLoaded", mountContent, { once: true });
}
