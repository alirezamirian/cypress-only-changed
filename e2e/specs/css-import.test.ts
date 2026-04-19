import { describe, it } from "node:test";
import { runFixture } from "../runFixture";

describe("css-import", { concurrency: false }, () => {
  it("no files changed — all specs skipped", () => {
    runFixture("css-import", []).assertAllSkipped();
  });

  it("Button.css changed — only Button runs (Label has no CSS dep)", () => {
    const ran = runFixture("css-import", ["Button.css"])
      .assertRan("Button.cy.tsx")
      .assertSkipped("Label.cy.tsx");
  });
});
