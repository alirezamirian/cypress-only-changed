import { Button } from ".";

describe("Button", () => {
  it("renders", () => {
    cy.mount(<Button label="click" />);
    cy.get("button").should("have.text", "click");
  });
});
