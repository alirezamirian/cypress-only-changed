# CypressOnlyChangedPlugin

Webpack 5 plugin that speeds up Cypress component-test CI by replacing the
source of specs whose transitive dep tree doesn't touch any changed file
with a stub containing a pending `it.skip` test. Tree-shaking-aware so barrel
re-exports don't drag in unrelated modules.

## Layout

- `src/CypressOnlyChangedPlugin.ts` — the plugin, plus the spec-level-filtering
  API: `filterOnlyChangedSpecs(config, options?)` (batteries-included: reads
  specs + webpack config from the Cypress config, rewrites `specPattern`,
  manages the placeholder), built from `discoverSpecs()` and
  `computeAffectedSpecs()`, all reusing the same tree-shaking-aware analysis
  (`resolveChangedFiles`, `collectTransitiveDeps`, `SPEC_PATTERN`)
- `e2e/` — everything test-related
  - `cypress.config.ts` — wires the plugin into Cypress component testing;
    reads `CHANGED_FILES` env var (JSON array of absolute paths); exports
    `RAN_SPECS_FILE` constant; registers `recordSpecRan` / `getRanSpecs` /
    `clearRanSpecs` tasks
  - `fixtures/` — self-contained fake apps; specs colocated next to source
    - `basic/` — direct and transitive dep scenarios (no barrel)
    - `barrel-exports/` — tree-shaking via barrel `index.ts`; includes
      `utils-barrel.ts` / `utils.ts` to demonstrate the `export *` false-positive
    - `css-import/` — CSS asset import scenario
    - `tsconfig.json`, `css.d.ts` — shared fixture config/typings
  - `runFixture.ts` — `runFixture(fixture, changedFiles)`: sets `CHANGED_FILES`
    (paths are relative to the fixture folder), runs `cypress run --component`,
    returns a result object with fluent assertion methods:
    `.assertRan(...specs)`, `.assertSkipped(...specs)`, `.assertAllSkipped()`
  - `specs/` — Node test runner suites
    - `basic.test.ts` — direct/transitive dep scenarios
    - `barrel-exports.test.ts` — tree-shaking via barrel scenarios
    - `css-import.test.ts` — CSS asset dep scenario
    - `compute-affected-specs.test.ts` — exercises `computeAffectedSpecs`,
      `discoverSpecs`, and `filterOnlyChangedSpecs` directly (webpack only, no
      Cypress browser) against the same fixtures, asserting the same affected
      sets as the stubbing tests — a fast parity / regression guard for the
      shared dependency-analysis logic
  - `support/` — Cypress support files (`component.ts`, `component-index.html`)
- `tsconfig.json` — **`"module": "commonjs"`** (needed elsewhere)
- `tsconfig.build.json` — overrides with `"module": "ESNext"`,
  `"moduleResolution": "bundler"` and is what `ts-loader` uses in the
  Cypress webpack build. **Don't change this** — with CommonJS, ts-loader
  downlevels `import`/`export` to `require()`, webpack only sees
  `CommonJsRequireDependency` instead of harmony deps, and the whole
  tree-shaking approach breaks.

Run the tests: `npm test`.

## Plugin architecture

Hooks `compilation.hooks.finishModules`. For each module matching
`/\.cy\.(ts|tsx)$/`:

1. `collectTransitiveDeps(specModule, moduleGraph)` — BFS that returns
   the set of resource paths the spec actually depends on.
2. If no dep path is in `this.changedFiles`, override `module.generator`
   via `Object.create` so `generate()` returns a stub:
   `describe('__skipped__', () => { it.skip('no changed dependencies — N files checked', () => {}); })`.
   **Do not** clear `module.dependencies` / `module.blocks` — that
   breaks chunk graph and you get `ChunkLoadError`.
3. With `debug: true` (set in `e2e/cypress.config.ts`): skipped stubs also
   include a `console.info` with the full dep list; running specs get a
   `before()` prepended (via generator wrapping with `ConcatSource`) that
   calls `Cypress.log` with the triggering changed files.

### Tree-shaking-aware BFS

Per-module state is `NeededExports = 'all' | Set<string>`. The BFS visits
each module with the set of its own exports that consumers care about.

The important trick: for each module we **group outgoing harmony deps by
`dep.request`** and make one decision per request via
`computeNeededForRequest(from, request, fromNeeded)`.

Why grouping is necessary — `export { X } from './Y'` produces TWO deps
for `./Y`:
- `HarmonyImportSideEffectDependency` (side-effect evaluation marker)
- `HarmonyExportImportedSpecifierDependency` (the named re-export)

If you process them independently, the re-export edge correctly gets
pruned when `X` isn't needed, but the side-effect edge still follows
with `'all'` and drags the whole module in anyway. Grouping lets you
decide "is this import statement actually needed?" across both.

`computeNeededForRequest` rules per request:
- namespace import (`import * as`) → `'all'`
- `export * from` → pass through `fromNeeded` conservatively
- named import `{ X }` → add X to needed
- named re-export `export { X } from` — only add if `X ∈ fromNeeded`
- only a bare side-effect eval and no specifiers (e.g. `import './setup'`)
  → `'all'`
- every dep for the request was dropped (all re-exports pruned) → return
  `null` → **edge is not followed**

Non-harmony connections (CJS require, dynamic import, asset, module
decorator) are followed conservatively with `'all'` — deduped by target
so we don't re-queue.

### Webpack 5 gotchas we've already hit

- `dep.id` getter THROWS in webpack 5.106.2 — it's renamed to
  `dep.ids: string[]`. Use the `depIds()` helper (falls back for older
  5.x).
- Harmony specifier/re-export deps DO appear in
  `moduleGraph.getOutgoingConnections()` — an earlier version of this
  plugin scanned `module.dependencies` under the mistaken belief they
  didn't. The comment history in the file reflects that dead end. We
  still read `from.dependencies` inside `computeNeededForRequest` because
  it's the natural place to enumerate all deps sharing a given
  `request`.

## Test quirks

- Each `runFixture` call runs all specs for that fixture in a single
  `cypress run`; the plugin processes all spec modules in one `finishModules`
  pass.
- `runFixture` passes `changedFiles` relative to the fixture folder; it
  resolves them to absolute paths before setting `CHANGED_FILES`.
- First full run after a change can have flaky failures (HMR/compilation
  timing in the dev server); re-run before debugging.

## When you need to debug the BFS

The git history of `src/CypressOnlyChangedPlugin.ts` has a version with
heavy traversal-level logging — `[BFS] visit ... needed={...}` and
`[req X] → target  follow/PRUNED` lines. Re-add temporarily; don't
commit with them on.
