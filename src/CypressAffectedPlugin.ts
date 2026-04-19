import type { Compiler, Compilation, Module } from "webpack";
import { NormalModule, sources } from "webpack";

const STUB_CONTENT = `describe('__skipped__', () => {});`;

interface CypressAffectedPluginOptions {
  changedFiles: string[];
}

const SPEC_PATTERN = /\.cy\.(ts|tsx)$/;

// 'all'        — the full module is needed (side-effects + every export).
// Set<string>  — only these named exports are needed; re-export edges
//                whose exported name isn't in the set can be pruned.
type NeededExports = "all" | Set<string>;

/**
 * Read the first imported/exported name from a HarmonyImportSpecifier or
 * HarmonyExportImportedSpecifier dependency.
 *
 * webpack 5 renamed `dep.id` → `dep.ids: string[]` (the old `.id` getter
 * throws at runtime).  This helper reads `.ids[0]` when available and falls
 * back to `.id` for older versions.
 */
function depIds(dep: any): string[] | null {
  if (Array.isArray(dep.ids)) return dep.ids as string[];
  // fallback for older webpack 5 minors where `.id` still works
  try {
    const v = dep.id;
    return v != null ? [v as string] : null;
  } catch {
    return null;
  }
}

/**
 * Compute what `from` actually needs out of the module imported via `request`,
 * given `fromNeeded` (what `from`'s consumers need out of `from`).
 *
 * Returns:
 *   - 'all'         → follow the edge; the whole target module is needed
 *   - Set<string>   → follow; only these named exports are needed
 *   - null          → DO NOT follow this request at all
 *
 * Why we process one `request` at a time (not one dep at a time):
 * A single `export { X } from './Y'` produces TWO webpack deps for './Y' —
 * a HarmonyImportSideEffectDependency and a HarmonyExportImportedSpecifier-
 * Dependency.  If we handled them independently, pruning the re-export edge
 * wouldn't help: the side-effect edge would still drag the whole module in.
 * Grouping by request lets us decide "is this import statement actually
 * needed?" once, considering imports and re-exports together.
 *
 * Rules (per request):
 *   • Any `import * as ns`  → 'all'
 *   • Any `export * from`   → pass through fromNeeded (conservative)
 *   • Named `import { X }`  → add X
 *   • Named `export { X } from`
 *       - if fromNeeded === 'all' || fromNeeded.has(X) → add the source id
 *       - else → drop (re-export not observable)
 *   • Only a bare side-effect eval with no specifiers
 *       → 'all' (treats as `import './setup'`)
 *   • If every dep for the request was dropped → null (prune edge)
 */
function computeNeededForRequest(
  from: NormalModule,
  request: string,
  fromNeeded: NeededExports,
  target: Module | null,
): NeededExports | null {
  let needed: Set<string> | null = null;
  let sawAnyDep = false;

  for (const dep of from.dependencies) {
    const d = dep as any;
    if (d?.request !== request) continue;
    const type: string | undefined = d?.type;

    if (type === "harmony side effect evaluation") {
      sawAnyDep = true;
      // Just a marker that the target may have side effects; contributes
      // no specific names. Whether we follow is decided by the other deps.
    } else if (type === "harmony import specifier") {
      sawAnyDep = true;
      const ids = depIds(d);
      if (!ids || ids.length === 0) return "all"; // namespace import
      needed ??= new Set();
      needed.add(ids[0]);
    } else if (type === "harmony export imported specifier") {
      sawAnyDep = true;
      const exportedName: string | null = d.name ?? null;
      if (exportedName === null) {
        // `export * from request` — only propagate names the target actually
        // provides. getProvidedExports() is populated by FlagDependencyExports-
        // Plugin which hasn't run yet at finishModules time, so we read the
        // target's own parse-time export dependencies instead — these are set
        // by the harmony parser during module building and are always available.
        if (fromNeeded === "all") return "all";
        if (target instanceof NormalModule) {
          let targetHasStarReexport = false;
          const targetProvides = new Set<string>();
          for (const td of target.dependencies) {
            const td_ = td as any;
            if (td_.type === "harmony export specifier") {
              targetProvides.add(td_.name);
            } else if (td_.type === "harmony export imported specifier") {
              if (td_.name !== null) targetProvides.add(td_.name);
              else targetHasStarReexport = true;
            }
          }
          if (targetHasStarReexport) {
            // Target itself star-re-exports; can't enumerate names statically
            // without recursing → conservative.
            needed ??= new Set();
            for (const n of fromNeeded) needed.add(n);
          } else {
            for (const n of fromNeeded) {
              if (targetProvides.has(n)) {
                needed ??= new Set();
                needed.add(n);
              }
            }
            // If no intersection, needed stays null → edge pruned below.
          }
        } else {
          // Non-NormalModule target → conservative.
          needed ??= new Set();
          for (const n of fromNeeded) needed.add(n);
        }
      } else {
        // Named re-export — only include if consumers actually want this name.
        const wanted =
          fromNeeded === "all" || (fromNeeded as Set<string>).has(exportedName);
        if (!wanted) continue;
        const ids = depIds(d);
        if (!ids || ids.length === 0) return "all";
        needed ??= new Set();
        needed.add(ids[0]);
      }
    }
  }

  if (!sawAnyDep) return null;
  if (needed === null) {
    // Request only had a bare side-effect eval (e.g. `import './setup'`) or
    // only had re-exports that were all pruned.
    // Bare side-effect imports are relatively rare; conservatively return
    // 'all' when the only dep was a side-effect eval. But if there were
    // re-exports that all got pruned, return null.
    const onlySideEffect = from.dependencies.every((dep) => {
      const d = dep as any;
      if (d?.request !== request) return true;
      return d?.type === "harmony side effect evaluation";
    });
    return onlySideEffect ? "all" : null;
  }
  return needed;
}

function mergeNeeded(
  existing: NeededExports | undefined,
  incoming: NeededExports,
): { changed: boolean; result: NeededExports } {
  if (existing === "all") return { changed: false, result: "all" };
  if (incoming === "all") return { changed: true, result: "all" };
  if (!existing) return { changed: true, result: new Set(incoming) };

  let changed = false;
  for (const name of incoming) {
    if (!existing.has(name)) {
      existing.add(name);
      changed = true;
    }
  }
  return { changed, result: existing };
}

/**
 * Walks the transitive dependency graph from `startModule`, tracking which
 * named exports are actually used at every step so that barrel/index files
 * don't pull in every module they re-export.
 *
 * For each outgoing edge we group webpack's harmony deps by `request` and
 * let computeNeededForRequest() decide — in one call, considering imports
 * and re-exports together — whether to follow the edge and with which
 * needed-set.  This is essential for barrel files where
 *   `export { X } from './Y'`
 * produces both a side-effect eval and an export-imported-specifier dep;
 * if we treated them independently the side-effect eval would drag the
 * whole module in even when the re-export got pruned.
 *
 * Non-harmony connections (CJS require, dynamic import, asset, module
 * decorators, …) are followed conservatively with 'all'.
 */
const HARMONY_TYPES = new Set([
  "harmony side effect evaluation",
  "harmony import specifier",
  "harmony export imported specifier",
]);

function collectTransitiveDeps(
  startModule: NormalModule,
  moduleGraph: Compilation["moduleGraph"],
): Set<string> {
  const needed = new Map<Module, NeededExports>();
  needed.set(startModule, "all");
  const queue: Module[] = [startModule];
  const paths = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentNeeded = needed.get(current)!;

    if (current instanceof NormalModule && current.resource) {
      paths.add(current.resource);
    }

    // Process each outgoing connection. Harmony deps pointing at the same
    // request share a single decision via computeNeededForRequest(); we
    // dedupe by request so we don't compute it N times.
    const seenHarmonyRequests = new Set<string>();
    const seenNonHarmonyTargets = new Set<Module>();

    for (const connection of moduleGraph.getOutgoingConnections(current)) {
      const target = connection.module;
      if (!target) continue;

      const dep = connection.dependency as any;
      const type: string | undefined = dep?.type;

      let incoming: NeededExports;

      if (type && HARMONY_TYPES.has(type)) {
        if (!(current instanceof NormalModule)) {
          incoming = "all";
        } else {
          const request: string = dep.request;
          if (seenHarmonyRequests.has(request)) continue;
          seenHarmonyRequests.add(request);

          const result = computeNeededForRequest(
            current,
            request,
            currentNeeded,
            target,
          );
          if (result === null) continue; // prune — nothing from target is needed
          incoming = result;
        }
      } else {
        // CJS require(), dynamic import(), asset, module decorator, etc.
        // Be conservative: follow with 'all'.
        if (seenNonHarmonyTargets.has(target)) continue;
        seenNonHarmonyTargets.add(target);
        incoming = "all";
      }

      const { changed, result } = mergeNeeded(needed.get(target), incoming);
      if (changed) {
        needed.set(target, result);
        queue.push(target);
      }
    }
  }

  return paths;
}

export class CypressAffectedPlugin {
  private readonly changedFiles: Set<string>;

  constructor({ changedFiles }: CypressAffectedPluginOptions) {
    this.changedFiles = new Set(changedFiles);
  }

  apply(compiler: Compiler): void {
    compiler.hooks.compilation.tap(
      "CypressAffectedPlugin",
      (compilation: Compilation) => {
        compilation.hooks.finishModules.tapAsync(
          "CypressAffectedPlugin",
          (modules, callback) => {
            try {
              const { moduleGraph } = compilation;

              for (const module of modules) {
                if (!(module instanceof NormalModule)) continue;
                if (!SPEC_PATTERN.test(module.resource)) continue;

                const allDeps = collectTransitiveDeps(module, moduleGraph);

                let hasChangedDep = false;
                for (const depPath of allDeps) {
                  if (this.changedFiles.has(depPath)) {
                    hasChangedDep = true;
                    break;
                  }
                }

                if (!hasChangedDep) {
                  const stubSource = new sources.RawSource(STUB_CONTENT);
                  const mod = module as NormalModule & { generator: object };
                  mod.generator = Object.create(mod.generator, {
                    generate: {
                      value: () => stubSource,
                      configurable: true,
                      writable: true,
                    },
                  });
                }
              }

              callback();
            } catch (err) {
              callback(err instanceof Error ? err : new Error(String(err)));
            }
          },
        );
      },
    );
  }
}
