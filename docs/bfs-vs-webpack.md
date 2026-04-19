# BFS vs `FlagDependencyUsagePlugin` — divergence analysis

`CypressAffectedPlugin` reimplements a subset of webpack's tree-shaking graph
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

### 4. Deep `export *` chains fall back to conservative

To resolve `export * from './target'`, the plugin reads the target module's
parse-time harmony dep types to enumerate what it provides. When the target
itself also has a star re-export (`export * from './deeper'`), its export list
cannot be enumerated statically without recursing, so `fromNeeded` is passed
through conservatively.

Webpack handles this correctly via `moduleGraph.getProvidedExports()`, which is
populated by `FlagDependencyExportsPlugin`. That plugin also hooks `finishModules`
but runs after `CypressAffectedPlugin`'s tap, so `getProvidedExports()` returns
`null` at the time the BFS runs.

**Impact:** In `A → B (export * from C) → C` chains, when only some of C's
exports are needed, the BFS may still include all of them. Uncommon in
application code; safe (no false negatives).

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

| Topic | Webpack | `CypressAffectedPlugin` | Notes |
|---|---|---|---|
| All dep types | `getDependencyReferencedExports(dep, runtime)` dispatch | Explicit handling of 3 harmony types; `'all'` for everything else | Equivalent for all standard dep types |
| CJS modules | `setUsedWithoutInfo` (no `exportsType`) | Non-harmony → follow with `'all'` | Equivalent |
| Namespace imports (`import * as ns`) | `getReferencedExports` returns `[{name: []}]` | `depIds(d).length === 0` → `'all'` | Equivalent |
| Named re-export ids | Nested `{name: ['a', 'b']}` for deep paths | `depIds(d)[0]` (first element) | Only the top-level imported name matters for deciding which source module to follow |

---

## Timing constraint

`FlagDependencyUsagePlugin` hooks `optimizeDependencies` (after `finishModules`).
`FlagDependencyExportsPlugin` also hooks `finishModules` but runs after
`CypressAffectedPlugin`'s tap.

`CypressAffectedPlugin` hooks `finishModules`. This means:

- `getProvidedExports()` → `null` (exports plugin hasn't run yet)
- `getUsedExports()` → always `null` (usage plugin hasn't run yet)
- Parse-time dep types (`harmony export specifier`, `harmony export imported specifier`) are set during the `make` phase and are always available at this hook.
