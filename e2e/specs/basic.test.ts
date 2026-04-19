import { describe, it } from "node:test";
import { runFixture } from "../runFixture";

describe("basic", { concurrency: false }, () => {
  it("no files changed — all specs skipped", () => {
    runFixture("basic", []).assertAllSkipped();
  });

  it("spec file itself changed — only that spec runs", () => {
    runFixture("basic", ["Button.cy.tsx"])
      .assertRan("Button.cy.tsx")
      .assertSkipped(
        "Input.cy.tsx",
        "Form.cy.tsx",
        "utils.cy.ts",
        "config.cy.ts",
      );
  });

  it("Button.tsx changed — Button and Form run", () => {
    runFixture("basic", ["Button.tsx"])
      .assertRan("Button.cy.tsx", "Form.cy.tsx")
      .assertSkipped("Input.cy.tsx", "utils.cy.ts", "config.cy.ts");
  });

  it("Input.tsx changed — Input and Form run", () => {
    const ran = runFixture("basic", ["Input.tsx"])
      .assertRan("Input.cy.tsx", "Form.cy.tsx")
      .assertSkipped("Button.cy.tsx", "utils.cy.ts", "config.cy.ts");
  });

  it("Input.tsx + format.ts changed — Input, Form, and utils run", () => {
    const ran = runFixture("basic", ["Input.tsx", "format.ts"])
      .assertRan("Input.cy.tsx", "Form.cy.tsx", "utils.cy.ts")
      .assertSkipped("Button.cy.tsx", "config.cy.ts");
  });

  it("config.ts changed — only config.cy.ts runs", () => {
    const ran = runFixture("basic", ["config.ts"])
      .assertRan("config.cy.ts")
      .assertSkipped(
        "Button.cy.tsx",
        "Input.cy.tsx",
        "Form.cy.tsx",
        "utils.cy.ts",
      );
  });
});
