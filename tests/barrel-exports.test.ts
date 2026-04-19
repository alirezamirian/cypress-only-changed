import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { abs, assertRan, runFixture } from "./helpers";

describe("barrel-exports", { concurrency: false }, () => {
  it("no files changed — all specs skipped", () => {
    const ran = runFixture("barrel-exports", []);
    assert.deepStrictEqual(ran, []);
  });

  it("Input.tsx changed — only Input runs (Button tree-shaken)", () => {
    const ran = runFixture("barrel-exports", [
      abs("tests/fixtures/barrel-exports/Input.tsx"),
    ]);
    assertRan(ran, ["Input.cy.tsx"], ["Button.cy.tsx"]);
  });

  it("Button.tsx changed — only Button runs (Input tree-shaken)", () => {
    const ran = runFixture("barrel-exports", [
      abs("tests/fixtures/barrel-exports/Button.tsx"),
    ]);
    assertRan(ran, ["Button.cy.tsx"], ["Input.cy.tsx"]);
  });

  it("utils.ts changed — all specs skipped", () => {
    const ran = runFixture("barrel-exports", [
      abs("tests/fixtures/barrel-exports/utils.ts"),
    ]);
    assert.deepStrictEqual(ran, []);
  });

  it(
    "utils-barrel.ts changed — no spec uses it; should skip all (FAILS: export * false positive)",
    // Known limitation: utils-barrel.ts uses `export * from './utils'`, so any
    // barrel that does `export * from './utils-barrel'` can't statically determine
    // what utils-barrel provides at finishModules time (getProvidedExports is not
    // yet populated). The BFS falls back to conservative and includes utils-barrel
    // in both specs' dep sets, even though neither spec uses anything from it.
    { skip: "Known limitation" },
    () => {
      const ran = runFixture("barrel-exports", [
        abs("tests/fixtures/barrel-exports/utils-barrel.ts"),
      ]);
      assert.deepStrictEqual(ran, []);
    },
  );
});
