# CypressAffectedPlugin

Webpack 5 plugin that speeds up Cypress component-test CI by replacing the
source of specs whose transitive dep tree doesn't touch any changed file
with `describe('__skipped__', () => {});`. Tree-shaking-aware so barrel
re-exports don't drag in unrelated modules.

## Layout

- `src/CypressAffectedPlugin.ts` — the plugin
- `cypress.config.ts` — wires the plugin into Cypress component testing,
  reads `CHANGED_FILES` env var (JSON array of absolute paths), registers
  `recordSpecRan` / `getRanSpecs` / `clearRanSpecs` tasks
- `scripts/test.ts` — scenario runner (the test suite). For each
  scenario, sets `CHANGED_FILES`, runs `cypress run --component`, reads
  `.ran-specs.json`, asserts `expectedToRun` / `expectedToSkip`
- `fixtures/` — test data: each subdirectory is a self-contained fake app
  - `fixtures/basic/` — baseline fixture; specs live next to the source
    they test (e.g. `Button.tsx` + `Button.cy.tsx` in the same dir)
- `support/` — Cypress support files (`component.ts`, `component-index.html`)
- `tsconfig.json` — **`"module": "commonjs"`** (needed elsewhere)
- `tsconfig.build.json` — overrides with `"module": "ESNext"`,
  `"moduleResolution": "bundler"` and is what `ts-loader` uses in the
  Cypress webpack build. **Don't change this** — with CommonJS, ts-loader
  downlevels `import`/`export` to `require()`, webpack only sees
  `CommonJsRequireDependency` instead of harmony deps, and the whole
  tree-shaking approach breaks.

Run the tests: `npm test` (or `npx ts-node scripts/test.ts`).

## Plugin architecture

Hooks `compilation.hooks.finishModules`. For each module matching
`/\.cy\.(ts|tsx)$/`:

1. `collectTransitiveDeps(specModule, moduleGraph)` — BFS that returns
   the set of resource paths the spec actually depends on.
2. If no dep path is in `this.changedFiles`, override `module.generator`
   via `Object.create` so `generate()` returns the `__skipped__` stub.
   **Do not** clear `module.dependencies` / `module.blocks` — that
   breaks chunk graph and you get `ChunkLoadError`.

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

- `scripts/test.ts` runs all specs per scenario through a single `cypress run`;
  the plugin processes all spec modules in one `finishModules` pass.
- Occasionally a scenario's `ran:` list contains a spec name twice
  (e.g. `utils.cy.ts, utils.cy.ts`) — harmless duplicate from cypress
  re-running, assertions use `includes()` so it passes.
- First full run after a change can have flaky failures (HMR/compilation
  timing in the dev server); re-run before debugging.

## When you need to debug the BFS

The git history of `src/CypressAffectedPlugin.ts` has a version with
heavy traversal-level logging — `[BFS] visit ... needed={...}` and
`[req X] → target  follow/PRUNED` lines. Re-add temporarily; don't
commit with them on.
