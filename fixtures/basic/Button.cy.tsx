import { Button } from './Button';

describe('Button', () => {
  beforeEach(() => {
    cy.task('recordSpecRan', 'Button.cy.tsx');
  });

  it('renders', () => {
    cy.mount(<Button label="click" />);
    cy.get('button').should('have.text', 'click');
  });
});
