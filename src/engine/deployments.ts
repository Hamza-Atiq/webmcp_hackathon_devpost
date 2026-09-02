import { nextId, type World } from "./world";

/**
 * Baseline deployment history — FR-2.4a.
 *
 * **Every service carries a prior version, and this is load-bearing rather than decorative.**
 * FR-2.4a requires `rollback_deployment` to be *executable* against any service and "never
 * refused for want of a target". That is what makes the trap in scenarios 3 and 5 work: an agent
 * that reflexively reaches for a rollback must be able to run one, watch it apply, and then watch
 * verification fail — because being refused would teach it nothing. Three services previously had
 * no history at all, so a rollback against them would have been refused and AC-8 would have been
 * untestable.
 *
 * These deployments are **deliberately old and unrelated**. They sit six to fourteen hours before
 * T+0, well outside any incident window, so an agent reading timestamps can see for itself that
 * they predate the degradation. Nothing here is a cause of anything.
 *
 * The authors match the on-call names in `ownership.ts`, so a suspicious deployment leads to a
 * real person on a real team.
 */

const HOUR = 60 * 60 * 1000;

export function seedBaselineHistory(world: World): void {
  const history = [
    {
      t: -14 * HOUR,
      service: "inventory-service" as const,
      version: "v2.2.0",
      previousVersion: "v2.1.9",
      author: "j.whitfield",
      diff: [{ key: "STOCK_CACHE_TTL_S", from: "30", to: "60" }],
      summary: "Extend stock cache TTL to reduce read load",
    },
    {
      t: -11 * HOUR,
      service: "payment-service" as const,
      version: "v4.0.2",
      previousVersion: "v4.0.1",
      author: "m.alvarez",
      diff: [{ key: "FRAUD_TIMEOUT_MS", from: "800", to: "1200" }],
      summary: "Raise fraud provider timeout after upstream slowdown",
    },
    {
      t: -9 * HOUR,
      service: "api-gateway" as const,
      version: "v3.1.4",
      previousVersion: "v3.1.3",
      author: "sara.lindqvist",
      diff: [{ key: "RATE_LIMIT_BURST", from: "200", to: "250" }],
      summary: "Raise burst allowance for checkout traffic",
    },
    {
      t: -6 * HOUR,
      service: "checkout-service" as const,
      version: "v2.4.0",
      previousVersion: "v2.3.8",
      author: "priya.raman",
      diff: [{ key: "CHECKOUT_RETRY_BACKOFF_MS", from: "100", to: "150" }],
      summary: "Increase retry backoff on payment calls",
    },
    {
      t: -3 * HOUR,
      service: "user-service" as const,
      version: "v1.9.2",
      previousVersion: "v1.9.1",
      author: "tom.becker",
      diff: [{ key: "SESSION_CACHE_TTL_S", from: "300", to: "600" }],
      summary: "Extend session cache TTL",
    },
  ];

  for (const entry of history) {
    world.deployments.push({
      id: nextId(world, "dep"),
      ...entry,
      rolledBack: false,
    });
  }
}
