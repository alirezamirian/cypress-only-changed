import assert from "node:assert/strict";
import {
  execSync,
  type ExecSyncOptionsWithStringEncoding,
} from "child_process";
import * as path from "path";
import * as fs from "fs";
import { RAN_SPECS_FILE } from "./cypress.config";

export function abs(relative: string): string {
  return path.join(path.resolve(__dirname), relative);
}

/**
 * Runs cypress tests in a fixture, and returns the list of ran spec, with some
 * assertion utilities.
 * @param fixture the name of the fixture folder inside fixtures.
 * @param changedFiles changed file paths, relative to the fixture folder.
 */
export function runFixture(fixture: string, changedFiles: string[]) {
  fs.writeFileSync(RAN_SPECS_FILE, "[]", "utf8");

  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd: path.resolve(__dirname),
    env: {
      ...process.env,
      CHANGED_FILES: JSON.stringify(
        changedFiles.map((changedFile) =>
          abs(`fixtures/${fixture}/${changedFile}`),
        ),
      ),
    },
    encoding: "utf8",
    stdio: "pipe",
  };

  let output = "";
  try {
    output = execSync(
      `npx cypress run --component --quiet --spec "fixtures/${fixture}/**/*.cy.{ts,tsx}"`,
      opts,
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    output = (e.stdout ?? "") + (e.stderr ?? "");
    if ((e.status ?? -1) > 1) {
      throw new Error(`cypress exited ${e.status ?? "unknown"}\n${output}`);
    }
  } finally {
    console.log("\nCypress logs");
    for (const line of output.split("\n").filter((line) => line.trim()))
      console.log(`  │ ${line}`);
  }

  const ranSpecs = JSON.parse(
    fs.readFileSync(RAN_SPECS_FILE, "utf8"),
  ) as string[];
  return {
    ranSpecs,
    assertRan(...specs: string[]) {
      specs.forEach((spec) => {
        assert.ok(
          ranSpecs.includes(spec),
          `expected "${spec}" to run but it didn't`,
        );
      });
      return this;
    },
    assertSkipped(...specs: string[]) {
      specs.forEach((spec) => {
        assert.ok(
          !ranSpecs.includes(spec),
          `expected "${spec}" to not run but it did`,
        );
      });
      return this;
    },
    assertAllSkipped() {
      assert(
        ranSpecs.length === 0,
        `expected all tests to skip but ${ranSpecs.length} ran: ${ranSpecs}`,
      );
    },
  };
}

export function assertRan(
  ran: string[],
  expectedToRun: string[],
  expectedToSkip: string[],
): void {
  for (const spec of expectedToRun) {
    assert.ok(
      ran.includes(spec),
      `expected "${spec}" to run — got: [${ran.join(", ")}]`,
    );
  }
  for (const spec of expectedToSkip) {
    assert.ok(
      !ran.includes(spec),
      `expected "${spec}" to be skipped — got: [${ran.join(", ")}]`,
    );
  }
}
