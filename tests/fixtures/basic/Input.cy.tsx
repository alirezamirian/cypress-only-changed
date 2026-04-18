import { Input } from './Input';

describe('Input', () => {
  it('renders', () => {
    cy.mount(<Input placeholder="type here" />);
    cy.get('input').should('have.attr', 'placeholder', 'type here');
  });
});
