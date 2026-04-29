# BFS vs `FlagDependencyUsagePlugin` — divergence analysis

`CypressOnlyChangedPlugin` reimplements a subset of webpack's tree-shaking graph
traversal to decide which specs are affected by a set of changed files.
Webpack's canonical implementation lives in
`node_modules/webpack/lib/FlagDependencyUsagePlugin.js`.

This document records every known divergence. All divergences are
**false-positive only**: our BFS may include extra deps, never miss real ones.
The worst outcome is an unnecessary spec run; an affected spec is never skipped.

---

## Divergences

### 1. Inactive conditional connections are followed

`FlagDependencyUsagePlugin` calls `connection.getActiveState(runtime)` and
skips any connection that is statically `false` — e.g. a conditional require
guarded by a compile-time constant:

```js
if (process.env.NODE_ENV === 'test') require('./test-only');
```

Our BFS follows all outgoing connections unconditionally.

**Impact:** If a spec's dep tree contains a dead conditional require that touches
a changed file, the spec is flagged as affected when it shouldn't be. Requires
statically-dead conditions; low likelihood in practice.

---

### 2. `sideEffects: false` modules are not short-circuited

Webpack skips deep traversal of modules whose `package.json` declares
`"sideEffects": false` when no exports from them are actually used
(`module.factoryMeta.sideEffectFree && usedExports.size === 0`). We always
traverse.

**Impact:** A utility from a `sideEffects: false` library that a spec never
directly uses (only transitively through a package-mate) can end up in the
spec's dep set. Low likelihood — the spec must have an import path leading
there.

---

### 3. `TRANSITIVE_ONLY` connections are followed conservatively

Webpack has a `TRANSITIVE_ONLY` active state meaning "propagate through this
connection's target edges but don't mark the module itself as used." We see
these as non-harmony connections and follow with `'all'`, which is conservative
but not incorrect.

**Impact:** The module is marked as a dep even though webpack would consider it
only transitively referenced. Extra false-positive dep; no false negatives.

---

### 4. Intermediate `export *` barrels are false-positived when they re-export via `export *`

To resolve `export * from './target'`, the plugin reads the target module's
parse-time harmony dep types to enumerate what names it provides. When the
target itself also contains a star re-export (`export * from './deeper'`), its
full export list cannot be determined statically, so the edge is followed
conservatively: the BFS visits that target even if it does not actually provide
any of the needed names.

Webpack handles this correctly via `moduleGraph.getProvidedExports()`, which is
populated by `FlagDependencyExportsPlugin`. That plugin also hooks `finishModules`
but runs after `CypressOnlyChangedPlugin`'s tap, so `getProvidedExports()` returns
`null` at the time the BFS runs.

**Concrete example.** Given a root barrel:

```ts
// src/index.ts
export * from './components';  // components/index.ts: export * from './Button', export * from './Input'
export * from './utils';       // utils/index.ts: export * from './formatDate', export * from './capitalize'
```

A spec that imports only `{ Button }` from `src/index.ts` causes this traversal:

- `src/index.ts` is visited with `needed = {'Button'}`.
- Processing `./components`: `components/index.ts` has star re-exports →
  `targetHasStarReexport = true` → follow with `{'Button'}`. ✓ correct
- Processing `./utils`: `utils/index.ts` has star re-exports →
  `targetHasStarReexport = true` → follow with `{'Button'}`. ✗ false positive
- Visiting `components/index.ts` with `{'Button'}`:
  - `./Button` provides `Button` → follow. ✓
  - `./Input` provides `Input`, no intersection → prune. ✓
- Visiting `utils/index.ts` with `{'Button'}`:
  - `./formatDate` provides `formatDate`, no intersection → prune. ✓
  - `./capitalize` provides `capitalize`, no intersection → prune. ✓

The leaf modules (`formatDate.ts`, `capitalize.ts`, `Input.tsx`) are correctly
excluded. But **`utils/index.ts` itself is in the dep set**: if it changes, the
spec is incorrectly flagged as affected.

**Scope.** The false positive is limited to intermediate barrel files that
(a) are reachable from the spec and (b) use `export *` syntax pointing at
modules that also use `export *`. Leaf source files in those barrels are
correctly pruned. The depth of the chain does not matter; what matters is
whether any barrel in the chain uses `export *` and that barrel's immediate
re-export targets also use `export *`. This pattern is common in React/TypeScript
codebases with nested component library barrels.

---

### 5. Async `import()` chunks with distinct runtimes are not isolated

Webpack explicitly walks `module.blocks` to recurse into async chunks and
processes each block's `entryOptions` runtime separately. We rely on
`moduleGraph.getOutgoingConnections()`, which does aggregate all connections
including those from blocks, so dynamic imports **are** followed — but we don't
replicate the per-async-runtime isolation.

In Cypress component testing all specs compile under a single entry runtime
(`browser.js` wrapper), so this distinction is moot in practice.

---

## Non-divergences (looks different, behaves the same)

| Topic | Webpack | `CypressOnlyChangedPlugin` | Notes |
|---|---|---|---|
| All dep types | `getDependencyReferencedExports(dep, runtime)` dispatch | Explicit handling of 3 harmony types; `'all'` for everything else | Equivalent for all standard dep types |
| CJS modules | `setUsedWithoutInfo` (no `exportsType`) | Non-harmony → follow with `'all'` | Equivalent |
| Namespace imports (`import * as ns`) | `getReferencedExports` returns `[{name: []}]` | `depIds(d).length === 0` → `'all'` | Equivalent |
| Named re-export ids | Nested `{name: ['a', 'b']}` for deep paths | `depIds(d)[0]` (first element) | Only the top-level imported name matters for deciding which source module to follow |

---

## Timing constraint

`FlagDependencyUsagePlugin` hooks `optimizeDependencies` (after `finishModules`).
`FlagDependencyExportsPlugin` also hooks `finishModules` but runs after
`CypressOnlyChangedPlugin`'s tap.

`CypressOnlyChangedPlugin` hooks `finishModules`. This means:

- `getProvidedExports()` → `null` (exports plugin hasn't run yet)
- `getUsedExports()` → always `null` (usage plugin hasn't run yet)
- Parse-time dep types (`harmony export specifier`, `harmony export imported specifier`) are set during the `make` phase and are always available at this hook.
