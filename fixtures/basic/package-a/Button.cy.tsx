import { Button } from ".";

describe("Button", () => {
  beforeEach(() => {
    cy.task("recordSpecRan", "package-a/Button.cy.tsx");
  });

  it("renders", () => {
    cy.mount(<Button label="click" />);
    cy.get("button").should("have.text", "click");
  });
});
