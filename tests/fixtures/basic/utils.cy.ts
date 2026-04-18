import { format } from './format';
import { validate } from './validate';

describe('utils', () => {
  it('format trims and lowercases', () => {
    expect(format('  Hello  ')).to.equal('hello');
  });

  it('validate returns true for non-empty strings', () => {
    expect(validate('hello')).to.be.true;
    expect(validate('')).to.be.false;
  });
});
