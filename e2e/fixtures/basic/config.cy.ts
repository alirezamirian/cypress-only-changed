import { APP_NAME } from './config';

describe('config', () => {
  it('knows the app name', () => {
    expect(APP_NAME).to.equal('MyApp');
  });
});
