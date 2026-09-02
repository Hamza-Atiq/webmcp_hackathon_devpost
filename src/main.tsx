import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { registerTools } from "./mcp/register";
import "./ui/styles.css";

// Registration runs once, outside the React tree. See the note in register.ts.
registerTools();

// Development only: expose the engine so the whole incident can be driven by hand in
// the browser console. Absent from the production bundle.
if (import.meta.env.DEV) {
  void import("./debug").then((m) => m.exposeConsoleHarness());
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
