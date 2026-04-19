import { Input } from ".";
import { Input as Input2 } from "./index_with-export-star";
import { Input as Input3 } from "./index_nested";

describe("Input", () => {
  it("renders", () => {
    cy.mount(<Input placeholder="type here" />);
    cy.mount(<Input2 placeholder="type here" />);
    cy.mount(<Input3 placeholder="type here" />);
    cy.get("input").should("have.attr", "placeholder", "type here");
  });
});
