import { Input } from './Input';

describe('Input', () => {
  beforeEach(() => {
    cy.task('recordSpecRan', 'Input.cy.tsx');
  });

  it('renders', () => {
    cy.mount(<Input placeholder="type here" />);
    cy.get('input').should('have.attr', 'placeholder', 'type here');
  });
});
