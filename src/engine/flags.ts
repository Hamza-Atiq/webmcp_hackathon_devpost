import type { FeatureFlag, ServiceName } from "./types";
import type { World } from "./world";

/**
 * Baseline feature flags — FR-4, and the precondition for FR-9's `disable_feature_flag`.
 *
 * **Every service owns at least one enabled flag, and that is load-bearing rather than
 * decorative.** FR-9.2 requires `disable_feature_flag` to be *executable* in scenario 1
 * and simply not to help. With no flags in the world it could only ever be refused, and a
 * refusal teaches an agent nothing about its hypothesis — the same argument that put a
 * prior deployment on every service in `deployments.ts`.
 *
 * `user_profile_schema_v2` is named by FR-9.4a: it is scenario 4's actual fix, because a
 * migration already in flight cannot be un-run by redeploying application code and the
 * real mitigation is to stop reading through the migrating schema. It sits here in the
 * baseline, enabled, in every scenario — a flag that appeared only when it was the answer
 * would identify the scenario the moment an agent listed flags (FR-2.5).
 */

const FLAGS: Array<{ key: string; service: ServiceName; description: string }> = [
  {
    key: "edge_response_cache",
    service: "api-gateway",
    description: "Cache successful GET responses at the edge for 30 seconds.",
  },
  {
    key: "checkout_v2_pricing",
    service: "checkout-service",
    description: "Use the v2 pricing engine for basket totals.",
  },
  {
    key: "payment_retry_aggressive",
    service: "payment-service",
    description: "Retry failed authorisations up to three times before giving up.",
  },
  {
    key: "stock_reservation_v2",
    service: "inventory-service",
    description: "Reserve stock at basket time rather than at checkout.",
  },
  {
    key: "user_profile_schema_v2",
    service: "user-service",
    description: "Read profile fields through the v2 schema.",
  },
];

export function seedFeatureFlags(world: World): void {
  for (const flag of FLAGS) {
    world.flags.push({ ...flag, enabled: true });
  }
}

export function flagByKey(world: World, key: string): FeatureFlag | undefined {
  return world.flags.find((f) => f.key === key);
}
