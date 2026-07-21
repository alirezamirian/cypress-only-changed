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

### Two modes

There are two ways to use this, sharing the exact same dependency analysis:

| Mode | How | Unaffected specs |
|---|---|---|
| **Stubbing** (the plugin) | `new CypressOnlyChangedPlugin()` in your webpack config | Still appear in the run, but their body is replaced with a pending `it.skip` |
| **Filtering** ([`filterOnlyChangedSpecs`](#spec-level-filtering-with-filteronlychangedspecs)) | Restrict Cypress `specPattern` in `setupNodeEvents` to the affected specs | Excluded from the run — the browser is never launched for them |

Stubbing is the simplest drop-in. Filtering is faster when most specs are
unaffected, because Cypress's fixed per-spec browser orchestration (navigating,
loading, tearing down a session for every spec) dominates the run time even when
a spec's body is a no-op `it.skip`. See
[Spec-level filtering](#spec-level-filtering-with-filteronlychangedspecs).

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

## Spec-level filtering with `filterOnlyChangedSpecs`

The stubbing plugin still lets Cypress start a browser session for every spec —
even the skipped ones. When most specs are unaffected, that per-spec overhead is
the bottleneck. Spec-level filtering runs the **same** dependency analysis once
up front and hands Cypress **only** the affected specs, so it never launches a
browser for the rest.

`filterOnlyChangedSpecs` is the batteries-included way to do this. Call it from
`setupNodeEvents` and return what it gives you — it reads everything it needs
from the Cypress `config` (spec globs **and** the webpack config), rewrites
`config.specPattern`, and manages the "nothing affected" placeholder internally:

```ts
// cypress.config.ts
import { defineConfig } from 'cypress';
import { filterOnlyChangedSpecs } from 'cypress-only-changed';

import webpackConfig from './cypress/webpack.config';

export default defineConfig({
  component: {
    devServer: { framework: 'react', bundler: 'webpack', webpackConfig },
    setupNodeEvents(on, config) {
      // No spec list, no placeholder file, no null-handling — the package
      // reads config.specPattern / config.excludeSpecPattern and
      // config.devServer.webpackConfig for you.
      return filterOnlyChangedSpecs(config);
    },
  },
});
```

Run it with the same `ONLY_CHANGED` variable as the plugin (see
[below](#only_changed-environment-variable)):

```bash
ONLY_CHANGED=origin/main cypress run --component
```

You **don't** need the `CypressOnlyChangedPlugin` in your webpack config when you
filter — the analysis is done for you.

### `filterOnlyChangedSpecs(config, options?)`

`config` is the Cypress config passed to `setupNodeEvents`. It reads
`projectRoot`, `specPattern`, `excludeSpecPattern`, and
`devServer.webpackConfig` from it. Behavior:

| `ONLY_CHANGED` / changes | Effect on `config.specPattern` |
|---|---|
| unset | untouched — every spec runs (no-op) |
| set, some specs affected | replaced with the affected spec paths |
| set, nothing affected | replaced with an internal placeholder spec (run exits 0) |

All `options` are optional:

| Option | Type | Default | Description |
|---|---|---|---|
| `webpackConfig` | `webpack.Configuration` | `config.devServer.webpackConfig` | Override the webpack config used for the graph pass. |
| `excludedPaths` | `string[]` | `['node_modules']` | Directory names excluded from the dependency walk. |
| `changedFiles` | `string[]` | _(git)_ | Explicit changed files (absolute paths). When omitted, the same `ONLY_CHANGED` git resolution as the plugin is used. |
| `placeholderSpecName` | `string` | `'no-affected-specs.cy.js'` | File name of the generated placeholder spec. |

> **Trade-off:** filtered-out specs don't appear in the Cypress report at all
> (unlike stubbing, where they show as pending). Affected-spec detection is
> identical to the plugin — it reuses the same tree-shaking-aware walk.

### Works with `cypress open` too

Because filtering happens in `setupNodeEvents` (not inside the webpack build), it
applies to **both** `cypress run` and `cypress open`. Opening the interactive
runner with `ONLY_CHANGED` set shows only the affected specs in the spec list —
handy for local development, since you can iterate on just the specs your change
touches instead of scrolling past the whole suite. (The in-webpack
`CypressOnlyChangedPlugin` also technically runs in `open`, but it only stubs
spec bodies — every spec still shows up in the list.)

> **Caveat:** the affected-spec list is computed **once**, when `setupNodeEvents`
> runs at startup. It does **not** react to files you edit during an open
> session — a spec that becomes affected (or unaffected) after you start won't
> appear or disappear until you restart Cypress. For a live, always-current list,
> run `cypress open` without `ONLY_CHANGED` (all specs) and rely on filtering
> only in CI / `cypress run`.

### Lower-level: `computeAffectedSpecs` / `discoverSpecs`

If you need more control (e.g. your dev server doesn't expose a plain webpack
config, or you want to decide what to do with the result yourself),
`filterOnlyChangedSpecs` is built from two smaller exports:

- `discoverSpecs(config)` → `string[]` — globs `config.specPattern` from
  `config.projectRoot`, honoring `config.excludeSpecPattern`, matching **files
  only** (a directory named like a spec — e.g. an image-snapshot folder — is
  ignored) and always excluding `node_modules`.
- `computeAffectedSpecs({ webpackConfig, specs, excludedPaths?, changedFiles? })`
  → `Promise<string[] | null>` — runs the single webpack graph pass and returns
  the affected specs (`null` when `ONLY_CHANGED` is unset → run all; `[]` when
  nothing is affected).

```ts
import { computeAffectedSpecs, discoverSpecs } from 'cypress-only-changed';

const specs = discoverSpecs(config);
const affected = await computeAffectedSpecs({ webpackConfig, specs });
// affected: null → run all, [] → run none, string[] → run these
```

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
