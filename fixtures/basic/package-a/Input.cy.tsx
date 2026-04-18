import { Input } from ".";

describe("Input", () => {
  beforeEach(() => {
    cy.task("recordSpecRan", "package-a/Input.cy.tsx");
  });

  it("renders", () => {
    cy.mount(<Input placeholder="type here" />);
    cy.get("input").should("have.attr", "placeholder", "type here");
  });
});
