import { APP_NAME } from './constants';

describe('unrelated', () => {
  beforeEach(() => {
    cy.task('recordSpecRan', 'unrelated.cy.ts');
  });

  it('knows the app name', () => {
    expect(APP_NAME).to.equal('MyApp');
  });
});
