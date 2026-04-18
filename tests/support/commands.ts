// Custom commands — imported by component.ts as needed

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /**
       * Mount a React component.
       * Defined in component.ts via cypress/react18.
       */
      mount: typeof import('cypress/react18').mount;

      /** Return the list of spec names that have been recorded via recordSpecRan task. */
      getRanSpecs(): Chainable<string[]>;
    }
  }
}

Cypress.Commands.add('getRanSpecs', () => cy.task<string[]>('getRanSpecs'));

export {};
