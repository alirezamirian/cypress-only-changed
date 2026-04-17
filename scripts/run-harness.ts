#!/usr/bin/env ts-node
/**
 * Harness runner for CypressAffectedPlugin.
 *
 * For each scenario:
 *   1. Clears the .ran-specs.json tracking file.
 *   2. Runs `cypress run --component` with CHANGED_FILES set.
 *   3. Reads .ran-specs.json to see which specs called recordSpecRan.
 *   4. Asserts expectedToRun and expectedToSkip match reality.
 *
 * Usage:
 *   npm test
 *   npx ts-node scripts/run-harness.ts
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";
import * as path from "path";
import * as fs from "fs";

const ROOT = path.resolve(__dirname, "..");
const RAN_SPECS_FILE = path.join(ROOT, ".ran-specs.json");

// ─── Helpers ────────────────────────────────────────────────────────────────

function abs(relative: string): string {
  return path.join(ROOT, relative);
}

function clearRanSpecs(): void {
  fs.writeFileSync(RAN_SPECS_FILE, JSON.stringify([]), "utf8");
}

function readRanSpecs(): string[] {
  try {
    return JSON.parse(fs.readFileSync(RAN_SPECS_FILE, "utf8")) as string[];
  } catch {
    return [];
  }
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  changedFiles: string[];
  expectedToRun: string[];
  expectedToSkip: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "no files changed — all specs skipped",
    changedFiles: [],
    expectedToRun: [],
    expectedToSkip: [
      "button.cy.tsx",
      "input.cy.tsx",
      "form.cy.tsx",
      "utils.cy.ts",
      "unrelated.cy.ts",
    ],
  },
  {
    name: "spec file itself changed — only that spec runs",
    changedFiles: [abs("cypress/fixtures/specs/button.cy.tsx")],
    expectedToRun: ["button.cy.tsx"],
    expectedToSkip: [
      "input.cy.tsx",
      "form.cy.tsx",
      "utils.cy.ts",
      "unrelated.cy.ts",
    ],
  },
  {
    name: "direct component dep changed (Button.tsx) — button and form run",
    changedFiles: [abs("cypress/fixtures/components/Button.tsx")],
    expectedToRun: ["button.cy.tsx", "form.cy.tsx"],
    expectedToSkip: ["input.cy.tsx", "utils.cy.ts", "unrelated.cy.ts"],
  },
  {
    name: "direct component dep changed (Input.tsx) — input and form run",
    changedFiles: [abs("cypress/fixtures/components/Input.tsx")],
    expectedToRun: ["input.cy.tsx", "form.cy.tsx"],
    expectedToSkip: ["button.cy.tsx", "utils.cy.ts", "unrelated.cy.ts"],
  },
  {
    name: "two util deps changed — input, form, and utils run",
    changedFiles: [
      abs("cypress/fixtures/components/Input.tsx"),
      abs("cypress/fixtures/components/format.ts"),
    ],
    expectedToRun: ["input.cy.tsx", "form.cy.tsx", "utils.cy.ts"],
    expectedToSkip: ["button.cy.tsx", "unrelated.cy.ts"],
  },
  {
    name: "constants.ts changed — only unrelated runs",
    changedFiles: [abs("cypress/fixtures/components/constants.ts")],
    expectedToRun: ["unrelated.cy.ts"],
    expectedToSkip: [
      "button.cy.tsx",
      "input.cy.tsx",
      "form.cy.tsx",
      "utils.cy.ts",
    ],
  },
  {
    name: "package-a Input.tsx changed — package-a-button.cy.tx does not run (tree-shaking)",
    changedFiles: [abs("cypress/fixtures/components/package-a/Input.tsx")],
    expectedToRun: ["package-a-input.cy.tsx"],
    expectedToSkip: ["package-a-button.cy.tsx"],
  },
];

// ─── Runner ─────────────────────────────────────────────────────────────────

interface ScenarioResult {
  scenario: string;
  passed: boolean;
  errors: string[];
  ranSpecs: string[];
}

function runScenario(scenario: Scenario): ScenarioResult {
  const errors: string[] = [];

  // Clear tracking file before the run
  clearRanSpecs();

  const changedFilesJson = JSON.stringify(scenario.changedFiles);

  const execOptions: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, CHANGED_FILES: changedFilesJson },
    encoding: "utf8",
    stdio: "pipe",
  };

  let cypressOutput = "";
  try {
    cypressOutput = execSync(
      'npx cypress run --component --quiet --spec "cypress/fixtures/specs/**/*.cy.{ts,tsx}"',
      execOptions,
    );
  } catch (err) {
    const execError = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    cypressOutput = (execError.stdout ?? "") + (execError.stderr ?? "");
    if ((execError.status ?? -1) > 1) {
      errors.push(`cypress exited ${execError.status} — see output below`);
    }
  }

  for (const line of cypressOutput.split("\n")) {
    console.log(`  │ ${line}`);
  }

  const ranSpecs = readRanSpecs();

  // Assert expectedToRun
  for (const expected of scenario.expectedToRun) {
    if (!ranSpecs.includes(expected)) {
      errors.push(`Expected "${expected}" to RUN but it was skipped.`);
    }
  }

  // Assert expectedToSkip
  for (const skipped of scenario.expectedToSkip) {
    if (ranSpecs.includes(skipped)) {
      errors.push(`Expected "${skipped}" to be SKIPPED but it ran.`);
    }
  }

  return {
    scenario: scenario.name,
    passed: errors.length === 0,
    errors,
    ranSpecs,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("\n=== CypressAffectedPlugin harness ===\n");

  const results: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    console.log(`Running scenario: ${scenario.name}`);
    const result = runScenario(scenario);
    results.push(result);

    if (result.passed) {
      console.log(`  PASSED  (ran: [${result.ranSpecs.join(", ")}])\n`);
    } else {
      console.log(`  FAILED`);
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
      console.log(`  (actual ran: [${result.ranSpecs.join(", ")}])\n`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  console.log(`\n=== Results: ${passed}/${total} scenarios passed ===\n`);

  if (passed < total) {
    process.exitCode = 1;
  }
}

main();
