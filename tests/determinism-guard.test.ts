import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards spec FR-1.5, FR-3.1 and AC-12.
 *
 * The engine must be reproducible from a seed alone: identical seed plus identical
 * action sequence must produce identical metrics, logs and traces. Two things break
 * that irreversibly, and both are invisible until late — `Math.random()` introduces
 * unseeded entropy, and `Date.now()` couples simulated state to wall-clock time,
 * which also violates FR-3.1 ("no business logic may derive timing from wall-clock
 * time") and makes results depend on frame timing.
 *
 * Catching these at hour 3 costs nothing. Catching them at hour 30 costs the project.
 * Wall-clock time is legitimate in exactly one place — the 60s approval timeout
 * (FR-3.5) — which lives in src/mcp, not here.
 */

const ENGINE = join(process.cwd(), "src", "engine");

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bMath\s*\.\s*random\s*\(/, why: "unseeded entropy breaks FR-1.5 replay" },
  { pattern: /\bDate\s*\.\s*now\s*\(/, why: "wall-clock time breaks FR-3.1 / FR-3.4a" },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, why: "wall-clock time breaks FR-3.1 / FR-3.4a" },
  { pattern: /\bperformance\s*\.\s*now\s*\(/, why: "wall-clock time breaks FR-3.1 / FR-3.4a" },
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("engine determinism guard", () => {
  it("uses no unseeded randomness and no wall-clock time", () => {
    const violations: string[] = [];

    for (const file of sourceFiles(ENGINE)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(line)) {
            const rel = file.slice(process.cwd().length + 1).replace(/\\/g, "/");
            violations.push(`${rel}:${i + 1} — ${line.trim()}  (${why})`);
          }
        }
      });
    }

    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });
});
