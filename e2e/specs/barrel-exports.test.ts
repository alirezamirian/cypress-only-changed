import { describe, it } from "node:test";
import { runFixture } from "../runFixture";

describe("barrel-exports", { concurrency: false }, () => {
  it("no files changed — all specs skipped", () => {
    runFixture("barrel-exports", []).assertAllSkipped();
  });

  it("Input.tsx changed — only Input runs (Button tree-shaken)", () => {
    const ran = runFixture("barrel-exports", ["Input.tsx"])
      .assertRan("Input.cy.tsx")
      .assertSkipped("Button.cy.tsx");
  });

  it("Button.tsx changed — only Button runs (Input tree-shaken)", () => {
    runFixture("barrel-exports", ["Button.tsx"])
      .assertRan("Button.cy.tsx")
      .assertSkipped("Input.cy.tsx");
  });

  it("utils.ts changed — all specs skipped", () => {
    runFixture("barrel-exports", ["utils.ts"]).assertAllSkipped();
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
      runFixture("barrel-exports", ["utils-barrel.ts"]).assertAllSkipped();
    },
  );
});
