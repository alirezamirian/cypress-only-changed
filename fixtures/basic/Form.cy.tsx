import { Form } from './Form';

describe('Form', () => {
  beforeEach(() => {
    cy.task('recordSpecRan', 'Form.cy.tsx');
  });

  it('renders', () => {
    cy.mount(<Form />);
    cy.get('form').should('exist');
    cy.get('input').should('have.attr', 'placeholder', 'name');
    cy.get('button').should('have.text', 'submit');
  });
});
