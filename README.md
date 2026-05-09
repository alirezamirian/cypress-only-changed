# cypress-only-changed

[![Test](https://github.com/alirezamirian/cypress-only-changed/actions/workflows/test.yml/badge.svg)](https://github.com/alirezamirian/cypress-only-changed/actions/workflows/test.yml)

A webpack plugin for Cypress **component** testing that skips specs whose
transitive dependency tree doesn't include any changed file. Similar to
`--only-changed` option in [jest](https://jestjs.io/docs/cli#--onlychanged)
or [playwright](https://playwright.dev/docs/test-cli#all-options).

Useful in CI to avoid running the full test suite on every commit: only specs
that _could_ be affected by the diff are executed.

## How it works

During webpack's `finishModules` phase the plugin walks the dependency graph
from each spec file. If none of the files in that spec's transitive dep tree
appear in the changed-files list, the spec's source is replaced with a stub:

```js
describe('__skipped__', () => {
  it.skip('no changed dependencies — N files checked', () => {});
});
```

The walk is tree-shaking–aware: barrel re-exports (`export { X } from './Y'`)
are followed only for the names that are actually imported, so an unrelated
module re-exported from the same index file doesn't pull the spec in.

## Requirements

The tree-shaking analysis relies on webpack's harmony (ESM) module graph.
**TypeScript source files must be compiled with `"module": "ESNext"` (or
`"preserve"`) in the tsconfig used by ts-loader.** With `"module": "commonjs"`,
every `import` is downleveled to `require()`, webpack sees only opaque CJS
connections, and the plugin cannot prune barrel re-exports — any spec that
imports from a shared barrel will be considered affected by any change to any
file that barrel transitively re-exports. The plugin emits a webpack warning
when it detects this situation.

### Configuring ts-loader for ESM output

If ts-loader has no explicit `configFile`, it picks up the nearest
`tsconfig.json`. If that file has `"module": "commonjs"` (a common default),
create a webpack-specific override and point ts-loader at it:

```json
// tsconfig.cypress-webpack.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler"
  }
}
```

## Installation

```bash
npm install --save-dev cypress-only-changed
```

## Setup

Add the plugin to your Cypress webpack configuration:

```ts
// cypress.config.ts
import { defineConfig } from 'cypress';
import { CypressOnlyChangedPlugin } from 'cypress-only-changed';

export default defineConfig({
  component: {
    devServer: {
      framework: 'react',
      bundler: 'webpack',
      webpackConfig: {
        plugins: [new CypressOnlyChangedPlugin()],
      },
    },
  },
});
```

The plugin is a **no-op by default** — all specs run normally unless
`ONLY_CHANGED` is set.

## Usage

Add scripts to `package.json` for the scenarios you need:

```json
{
  "scripts": {
    "test": "cypress run --component",
    "test:affected": "ONLY_CHANGED=origin/main npm run test",
    "test:uncommitted": "ONLY_CHANGED= npm run test"
  }
}
```

| Script | What it runs |
|---|---|
| `test` | All specs (plugin is a no-op) |
| `test:affected` | Specs affected by commits on the current branch vs `origin/main` |
| `test:uncommitted` | Specs affected by uncommitted working-tree changes |

### `ONLY_CHANGED` environment variable

| Value | Changed files source |
|---|---|
| _(unset)_ | Plugin is a no-op; all specs run |
| Empty (`ONLY_CHANGED=`) | `git diff --name-only HEAD` — uncommitted changes |
| A ref (`ONLY_CHANGED=origin/main`) | `git diff --name-only origin/main...HEAD` — branch diff |

Paths are resolved relative to the git repository root.

## Plugin options

```ts
new CypressOnlyChangedPlugin(options?)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `log` | `false \| ReporterEntry \| ReporterEntry[]` | `'minimal'` | Reporter(s) to call per spec. `false` silences all per-spec logging. |
| `excludedPaths` | `string[]` | `['node_modules']` | Directory names to exclude from the dependency walk. |

## Logging

### Default: `'minimal'`

When `log` is not set the built-in minimal reporter prints one line per spec —
no dependency tree:

```
[cypress-only-changed] SKIP  Button.cy.ts
[cypress-only-changed] RUN   Form.cy.ts  (2 changed deps)
```

### Verbose reporter

The `'verbose'` reporter prints the same `SKIP`/`RUN` line plus an ASCII tree
of the dependency paths that led to the decision (changed files are highlighted;
unchanged deps are dimmed):

```ts
new CypressOnlyChangedPlugin({ log: 'verbose' })
```

```
[cypress-only-changed] SKIP  Button.cy.ts
[cypress-only-changed] RUN   Form.cy.ts
  ├── components/Form.tsx
  │   └── utils/validation.ts
  └── styles/form.css
```

### GitHub Actions summary

The `'github-actions'` reporter writes a Markdown table to
[`$GITHUB_STEP_SUMMARY`](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#adding-a-job-summary)
— the panel shown at the bottom of each GitHub Actions job run. It is a no-op
when `GITHUB_STEP_SUMMARY` is not set (i.e. outside of GitHub Actions).

```ts
new CypressOnlyChangedPlugin({ log: ['minimal', 'github-actions'] })
```

The summary looks like this:

| Spec | Status | Changed dependencies |
|---|:---:|---|
| `Button.cy.ts` | ⏭ skip | — |
| `Form.cy.ts` | ▶ run | `validation.ts` and 2 more |
| `Login.cy.ts` | ▶ run | `auth.ts` |

### Custom reporter

Pass a function, or an array to combine reporters:

```ts
import { CypressOnlyChangedPlugin, SpecReport } from 'cypress-only-changed';

new CypressOnlyChangedPlugin({
  log: ({ specPath, changedDeps }: SpecReport) => {
    console.log(specPath, changedDeps.length > 0 ? 'RUN' : 'SKIP');
  },
})

// combine with a builtin:
new CypressOnlyChangedPlugin({ log: ['verbose', myCustomReporter] })
```

`SpecReport` fields:

| Field | Type | Description |
|---|---|---|
| `specPath` | `string` | Absolute path to the spec file |
| `deps` | `string[]` | All transitive dependency paths |
| `changedDeps` | `string[]` | Subset of `deps` that appear in the changed-files list |
| `directDeps` | `Map<string, string[]>` | Adjacency map for tree rendering (path → direct dep paths) |
