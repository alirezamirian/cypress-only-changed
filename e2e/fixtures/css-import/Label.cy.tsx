import { Label } from './Label';

describe('Label', () => {
  it('renders', () => {
    cy.mount(<Label text="hello" />);
    cy.get('span').should('have.text', 'hello');
  });
});
