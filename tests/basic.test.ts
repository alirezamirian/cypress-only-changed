import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abs, assertRan, runFixture } from './helpers';

describe('basic', { concurrency: false }, () => {
  it('no files changed — all specs skipped', () => {
    const ran = runFixture('basic', []);
    assert.deepStrictEqual(ran, []);
  });

  it('spec file itself changed — only that spec runs', () => {
    const ran = runFixture('basic', [abs('tests/fixtures/basic/Button.cy.tsx')]);
    assertRan(ran, ['Button.cy.tsx'], ['Input.cy.tsx', 'Form.cy.tsx', 'utils.cy.ts', 'config.cy.ts']);
  });

  it('Button.tsx changed — Button and Form run', () => {
    const ran = runFixture('basic', [abs('tests/fixtures/basic/Button.tsx')]);
    assertRan(ran, ['Button.cy.tsx', 'Form.cy.tsx'], ['Input.cy.tsx', 'utils.cy.ts', 'config.cy.ts']);
  });

  it('Input.tsx changed — Input and Form run', () => {
    const ran = runFixture('basic', [abs('tests/fixtures/basic/Input.tsx')]);
    assertRan(ran, ['Input.cy.tsx', 'Form.cy.tsx'], ['Button.cy.tsx', 'utils.cy.ts', 'config.cy.ts']);
  });

  it('Input.tsx + format.ts changed — Input, Form, and utils run', () => {
    const ran = runFixture('basic', [
      abs('tests/fixtures/basic/Input.tsx'),
      abs('tests/fixtures/basic/format.ts'),
    ]);
    assertRan(ran, ['Input.cy.tsx', 'Form.cy.tsx', 'utils.cy.ts'], ['Button.cy.tsx', 'config.cy.ts']);
  });

  it('config.ts changed — only config.cy.ts runs', () => {
    const ran = runFixture('basic', [abs('tests/fixtures/basic/config.ts')]);
    assertRan(ran, ['config.cy.ts'], ['Button.cy.tsx', 'Input.cy.tsx', 'Form.cy.tsx', 'utils.cy.ts']);
  });
});
