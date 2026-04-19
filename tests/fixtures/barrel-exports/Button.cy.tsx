import { Button } from ".";
import { Button as Button2 } from "./index_with-export-star";
import { Button as Button3 } from "./index_nested";

describe("Button", () => {
  it("renders", () => {
    cy.mount(<Button label="click" />);
    cy.mount(<Button2 label="click" />);
    cy.mount(<Button3 label="click" />);
    cy.get("button").should("have.text", "click");
  });
});
