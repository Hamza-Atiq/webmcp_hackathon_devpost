import type { World } from "../world";
import { onset as s1 } from "./s1";
import { onset as s2 } from "./s2";
import { onset as s3 } from "./s3";
import { onset as s4 } from "./s4";
import { onset as s5 } from "./s5";

/**
 * The scenario registry — FR-2.1.
 *
 * A scenario is an onset function and nothing more: it changes the environment's inputs
 * once and then has no further say. There is deliberately no field here for symptoms,
 * severity, expected diagnosis or correct remediation, because the moment such a field
 * exists something will read it and the outcome matrix in FR-9.2 will have become a
 * lookup table instead of a consequence.
 *
 * **Labels are numbers on purpose.** FR-2.1 makes scenarios selectable by name, and the
 * selector is a human control; but a label reading "memory leak" in the interface would
 * hand a judge the answer before they investigated, and FR-2.5 forbids the tool layer
 * from disclosing it at all. The number is the name.
 */

/**
 * Only scenarios with a real mechanism appear here. The union grows as each is built,
 * so an unimplemented id is a compile error rather than a scenario that quietly runs
 * somebody else's onset.
 */
export type ScenarioId = "s1" | "s2" | "s3" | "s4" | "s5";

export const SCENARIO_IDS: readonly ScenarioId[] = ["s1", "s2", "s3", "s4", "s5"];

export const SCENARIO_LABELS: Record<ScenarioId, string> = {
  s1: "Scenario 1",
  s2: "Scenario 2",
  s3: "Scenario 3",
  s4: "Scenario 4",
  s5: "Scenario 5",
};

const ONSETS: Record<ScenarioId, (world: World) => void> = { s1, s2, s3, s4, s5 };

export function startScenario(world: World, id: ScenarioId): void {
  ONSETS[id](world);
}
