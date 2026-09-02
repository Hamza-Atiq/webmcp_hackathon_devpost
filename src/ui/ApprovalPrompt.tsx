import { useEffect, useState } from "react";
import type { Engine } from "../engine";
import type { EvidenceRegistry } from "../mcp/evidence";
import type { Proposal } from "../mcp/proposals";
import { describeEvidence } from "./evidenceText";

/**
 * The moment the product exists for — FR-8.9, FR-7.6.
 *
 * An agent's tool call is suspended on this panel. It is deliberately unmissable: full
 * width, above the working columns, and it does not go away on its own until the sixty
 * seconds run out. A badge somewhere would technically satisfy "the human decides" and
 * would in practice be approved without reading, which is the failure mode the whole
 * design is arranged against.
 *
 * It is **amber, never red.** Red means an open incident and nothing else in this
 * interface; a second red element would dilute the one signal that means something is
 * broken. An approval is attention, not alarm.
 *
 * Denial asks for a reason because FR-8.6 hands that reason back to the agent. Inventing
 * "denied by user" would give it nothing to reason about and it would simply try again.
 */

export function ApprovalPrompt({
  proposal,
  engine,
  evidence,
  onApprove,
  onDeny,
}: {
  proposal: Proposal;
  engine: Engine;
  evidence: EvidenceRegistry;
  onApprove(id: string): void;
  onDeny(id: string, reason: string): void;
}) {
  const [reason, setReason] = useState("");
  const [denying, setDenying] = useState(false);

  /*
   * A real-time countdown, on its own interval rather than the simulation's repaint. The
   * timeout is wall-clock (FR-3.5) and must read the same at 1x and 60x — driving it from
   * the render loop would make it appear to run at the speed of the simulation.
   */
  const [remaining, setRemaining] = useState(() => secondsLeft(proposal.approvalDeadline));
  useEffect(() => {
    setRemaining(secondsLeft(proposal.approvalDeadline));
    const timer = setInterval(() => setRemaining(secondsLeft(proposal.approvalDeadline)), 250);
    return () => clearInterval(timer);
  }, [proposal.approvalDeadline]);

  const parameters = Object.entries(proposal.parameters).filter(([, v]) => v !== undefined);

  return (
    <section className="approval" role="alertdialog" aria-labelledby="approval-title">
      <header className="approval-head">
        <span className="approval-tag">Approval required</span>
        <h2 id="approval-title">
          The agent is asking to <strong>{proposal.action.replace(/_/g, " ")}</strong> on{" "}
          <strong>{proposal.service}</strong>
        </h2>
        <span className={`blast is-${proposal.blastRadius.toLowerCase()}`}>
          {proposal.blastRadius} blast radius
        </span>
        <span className="approval-clock" aria-live="off">
          {remaining}s
        </span>
      </header>

      <div className="approval-body">
        <div className="approval-column">
          <h3 className="approval-label">Why the agent thinks so</h3>
          <p className="hypothesis">{proposal.hypothesis}</p>
          {parameters.length > 0 && (
            <p className="approval-params">
              {parameters.map(([key, value]) => (
                <span key={key}>
                  {key}: <strong>{String(value)}</strong>
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="approval-column">
          <h3 className="approval-label">Evidence it cited ({proposal.evidenceIds.length})</h3>
          <ul className="cited">
            {proposal.evidenceIds.map((id) => (
              <li key={id}>
                <span className="cited-id">{id}</span>
                <span className="cited-text">{describeEvidence(engine, evidence, id)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {denying ? (
        <form
          className="approval-deny"
          onSubmit={(e) => {
            e.preventDefault();
            onDeny(proposal.id, reason.trim() || "no reason given");
          }}
        >
          <label htmlFor="deny-reason">
            Why not? The agent receives this and will reason about it.
          </label>
          <div className="approval-deny-row">
            <input
              id="deny-reason"
              className="search"
              autoFocus
              value={reason}
              placeholder="e.g. we are mid-sale, roll back after 18:00"
              onChange={(e) => setReason(e.target.value)}
            />
            <button type="submit" className="deny">
              Send denial
            </button>
            <button type="button" className="ghost" onClick={() => setDenying(false)}>
              Back
            </button>
          </div>
        </form>
      ) : (
        <div className="approval-actions">
          <button type="button" className="approve" onClick={() => onApprove(proposal.id)}>
            Approve and apply
          </button>
          <button type="button" className="deny" onClick={() => setDenying(true)}>
            Deny
          </button>
          <span className="approval-note">
            Nothing changes until you choose. The agent's call is waiting on this decision.
          </span>
        </div>
      )}
    </section>
  );
}

function secondsLeft(deadline: number | null): number {
  if (deadline === null) return 0;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}
