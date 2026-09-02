import type { ServiceName } from "./types";

/**
 * Service ownership and on-call — FR-4.6.
 *
 * Reference data, identical in every run, so the ids are static. Nothing here is a credential or
 * a contactable address: the people are fictional and the channels are names, not endpoints. An
 * incident console needs to answer "who owns this and who is awake", and that is all this answers.
 *
 * The authors who appear in the deployment history are the same names that appear here, because
 * an agent that finds a suspicious deployment should be able to work out who to talk to — that
 * link is part of what makes the evidence feel like one system rather than four fixtures.
 */

export interface Ownership {
  id: string;
  service: ServiceName;
  team: string;
  onCall: string;
  escalation: string;
  channel: string;
  /** How the team wants to be reached out of hours, in plain words. */
  policy: string;
}

export const OWNERSHIP: Record<ServiceName, Ownership> = {
  "api-gateway": {
    id: "own_api-gateway",
    service: "api-gateway",
    team: "Edge Platform",
    onCall: "sara.lindqvist",
    escalation: "Edge Platform lead, then the incident commander rota",
    channel: "#edge-platform",
    policy: "Page for any SEV-1 or SEV-2. SEV-3 waits for business hours.",
  },
  "checkout-service": {
    id: "own_checkout-service",
    service: "checkout-service",
    team: "Checkout",
    onCall: "d.okafor",
    escalation: "priya.raman, then the Commerce engineering manager",
    channel: "#checkout-eng",
    policy: "Page for anything affecting order completion, at any severity.",
  },
  "payment-service": {
    id: "own_payment-service",
    service: "payment-service",
    team: "Payments",
    onCall: "m.alvarez",
    escalation: "Payments lead, then Finance engineering on call",
    channel: "#payments-eng",
    policy: "Page immediately for failed payment capture. Latency alone escalates after 15 minutes.",
  },
  "inventory-service": {
    id: "own_inventory-service",
    service: "inventory-service",
    team: "Fulfilment",
    onCall: "j.whitfield",
    escalation: "Fulfilment lead, then the warehouse operations duty manager",
    channel: "#fulfilment-eng",
    policy: "Page for stock accuracy problems. Read latency escalates after 30 minutes.",
  },
  "user-service": {
    id: "own_user-service",
    service: "user-service",
    team: "Identity",
    onCall: "tom.becker",
    escalation: "Identity lead, then the security duty engineer",
    channel: "#identity-eng",
    policy: "Page for sign-in failures. Profile read latency escalates after 30 minutes.",
  },
};

export function ownershipFor(service: ServiceName): Ownership {
  return OWNERSHIP[service];
}
