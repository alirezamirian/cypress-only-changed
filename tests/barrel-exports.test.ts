import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abs, assertRan, runFixture } from './helpers';

describe('barrel-exports', { concurrency: false }, () => {
  it('no files changed — all specs skipped', () => {
    const ran = runFixture('barrel-exports', []);
    assert.deepStrictEqual(ran, []);
  });

  it('Input.tsx changed — only Input runs (Button tree-shaken)', () => {
    const ran = runFixture('barrel-exports', [abs('tests/fixtures/barrel-exports/Input.tsx')]);
    assertRan(ran, ['Input.cy.tsx'], ['Button.cy.tsx']);
  });

  it('Button.tsx changed — only Button runs (Input tree-shaken)', () => {
    const ran = runFixture('barrel-exports', [abs('tests/fixtures/barrel-exports/Button.tsx')]);
    assertRan(ran, ['Button.cy.tsx'], ['Input.cy.tsx']);
  });
});
