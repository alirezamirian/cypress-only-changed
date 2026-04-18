#!/usr/bin/env ts-node

import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";
import * as path from "path";
import * as fs from "fs";

const ROOT = path.resolve(__dirname, "..");
const RAN_SPECS_FILE = path.join(ROOT, ".ran-specs.json");

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
      "Button.cy.tsx",
      "Input.cy.tsx",
      "Form.cy.tsx",
      "utils.cy.ts",
      "unrelated.cy.ts",
    ],
  },
  {
    name: "spec file itself changed — only that spec runs",
    changedFiles: [abs("fixtures/basic/Button.cy.tsx")],
    expectedToRun: ["Button.cy.tsx"],
    expectedToSkip: [
      "Input.cy.tsx",
      "Form.cy.tsx",
      "utils.cy.ts",
      "unrelated.cy.ts",
    ],
  },
  {
    name: "direct component dep changed (Button.tsx) — button and form run",
    changedFiles: [abs("fixtures/basic/Button.tsx")],
    expectedToRun: ["Button.cy.tsx", "Form.cy.tsx"],
    expectedToSkip: ["Input.cy.tsx", "utils.cy.ts", "unrelated.cy.ts"],
  },
  {
    name: "direct component dep changed (Input.tsx) — input and form run",
    changedFiles: [abs("fixtures/basic/Input.tsx")],
    expectedToRun: ["Input.cy.tsx", "Form.cy.tsx"],
    expectedToSkip: ["Button.cy.tsx", "utils.cy.ts", "unrelated.cy.ts"],
  },
  {
    name: "two util deps changed — input, form, and utils run",
    changedFiles: [
      abs("fixtures/basic/Input.tsx"),
      abs("fixtures/basic/format.ts"),
    ],
    expectedToRun: ["Input.cy.tsx", "Form.cy.tsx", "utils.cy.ts"],
    expectedToSkip: ["Button.cy.tsx", "unrelated.cy.ts"],
  },
  {
    name: "constants.ts changed — only unrelated runs",
    changedFiles: [abs("fixtures/basic/constants.ts")],
    expectedToRun: ["unrelated.cy.ts"],
    expectedToSkip: [
      "Button.cy.tsx",
      "Input.cy.tsx",
      "Form.cy.tsx",
      "utils.cy.ts",
    ],
  },
  {
    name: "package-a Input.tsx changed — package-a/Button.cy.tsx does not run (tree-shaking)",
    changedFiles: [abs("fixtures/basic/package-a/Input.tsx")],
    expectedToRun: ["package-a/Input.cy.tsx"],
    expectedToSkip: ["package-a/Button.cy.tsx"],
  },
];

interface ScenarioResult {
  scenario: string;
  passed: boolean;
  errors: string[];
  ranSpecs: string[];
}

function runScenario(scenario: Scenario): ScenarioResult {
  const errors: string[] = [];

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
      'npx cypress run --component --quiet --spec "fixtures/basic/**/*.cy.{ts,tsx}"',
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

  for (const expected of scenario.expectedToRun) {
    if (!ranSpecs.includes(expected)) {
      errors.push(`Expected "${expected}" to RUN but it was skipped.`);
    }
  }

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

function main(): void {
  console.log("\n=== CypressAffectedPlugin tests ===\n");

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
