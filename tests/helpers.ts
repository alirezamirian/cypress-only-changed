import assert from "node:assert/strict";
import {
  execSync,
  type ExecSyncOptionsWithStringEncoding,
} from "child_process";
import * as path from "path";
import * as fs from "fs";

export const ROOT = path.resolve(__dirname, "..");
const RAN_SPECS_FILE = path.join(ROOT, ".ran-specs.json");

export function abs(relative: string): string {
  return path.join(ROOT, relative);
}

export function runFixture(fixture: string, changedFiles: string[]): string[] {
  fs.writeFileSync(RAN_SPECS_FILE, "[]", "utf8");

  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, CHANGED_FILES: JSON.stringify(changedFiles) },
    encoding: "utf8",
    stdio: "pipe",
  };

  let output = "";
  try {
    output = execSync(
      `npx cypress run --component --quiet --spec "tests/fixtures/${fixture}/**/*.cy.{ts,tsx}"`,
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

  try {
    return JSON.parse(fs.readFileSync(RAN_SPECS_FILE, "utf8")) as string[];
  } catch {
    return [];
  }
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
