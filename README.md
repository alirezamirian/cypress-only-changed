# cypress-only-changed

A webpack plugin for Cypress component testing that skips specs whose
transitive dependency tree doesn't include any changed file.

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
    "test:affected": "ONLY_CHANGED=origin/main cypress run --component",
    "test:uncommitted": "ONLY_CHANGED= cypress run --component"
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
| `report` | `boolean \| Reporter` | `false` | Log per-spec decisions. `true` uses the built-in coloured tree reporter; pass a function for a custom reporter. |
| `excludedPaths` | `string[]` | `['node_modules']` | Directory names to exclude from the dependency walk. |

### Custom reporter

```ts
import { CypressOnlyChangedPlugin, SpecReport } from 'cypress-only-changed';

new CypressOnlyChangedPlugin({
  report: ({ specPath, deps, changedDeps, directDeps }: SpecReport) => {
    console.log(specPath, changedDeps.length > 0 ? 'RUN' : 'SKIP');
  },
})
```

`SpecReport` fields:

| Field | Type | Description |
|---|---|---|
| `specPath` | `string` | Absolute path to the spec file |
| `deps` | `string[]` | All transitive dependency paths |
| `changedDeps` | `string[]` | Subset of `deps` that appear in the changed-files list |
| `directDeps` | `Map<string, string[]>` | Adjacency map for tree rendering (path → direct dep paths) |
