import { webmcpAvailable } from "../mcp/register";

export function App() {
  const webmcp = webmcpAvailable();

  return (
    <div className="shell">
      <header className="topbar">
        <h1>AgentOps Command Center</h1>
        <span className="tag">Incident Response</span>
        <span className="spacer" />
        <span className="pill">
          <span className={`dot ${webmcp ? "on" : "off"}`} />
          {webmcp ? "WebMCP detected" : "WebMCP unavailable"}
        </span>
      </header>

      <main className="stage">
        <div className="placeholder">
          <h2>Simulation engine not yet wired</h2>
          <p>
            Deployment skeleton is live. The simulated production environment, the evidence
            sources and the WebMCP tool layer land in the phases that follow.
          </p>
          <p>
            {webmcp
              ? "This browser exposes document.modelContext — site tools will be discoverable here."
              : "No WebMCP support in this browser. The console remains fully usable by a human."}
          </p>
          <p>
            <code>chrome://flags/#enable-webmcp-testing</code>
          </p>
        </div>
      </main>
    </div>
  );
}
