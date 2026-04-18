import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abs, assertRan, runFixture } from './helpers';

describe('css-import', { concurrency: false }, () => {
  it('no files changed — all specs skipped', () => {
    const ran = runFixture('css-import', []);
    assert.deepStrictEqual(ran, []);
  });

  it('Button.css changed — only Button runs (Label has no CSS dep)', () => {
    const ran = runFixture('css-import', [abs('tests/fixtures/css-import/Button.css')]);
    assertRan(ran, ['Button.cy.tsx'], ['Label.cy.tsx']);
  });
});
