import { execSync } from "child_process";
import * as path from "path";
import type { Compiler, Compilation, Module } from "webpack";
import { NormalModule, WebpackError, sources } from "webpack";

export interface SpecReport {
  specPath: string;
  deps: string[];
  changedDeps: string[];
  directDeps: Map<string, string[]>; // adjacency: path → its direct followed dep paths
}

interface CypressOnlyChangedPluginOptions {
  report?: boolean | ((report: SpecReport) => void);
  excludedPaths?: string[];
}

function gitRepoRoot(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

interface ResolvedChangedFiles {
  files: string[];
  label: string; // human-readable description for the startup log
}

function resolveChangedFiles(): ResolvedChangedFiles | null {
  // Undocumented: used by the test harness to inject explicit paths without git.
  const override = process.env._CHANGED_FILES;
  if (override) {
    const files = JSON.parse(override) as string[];
    return { files, label: `${files.length} changed file(s) (injected)` };
  }

  // ONLY_CHANGED mirrors Playwright's --only-changed semantics:
  //   (unset)        → plugin is a no-op; all specs run normally
  //   ONLY_CHANGED=  → uncommitted changes   (git diff --name-only HEAD)
  //   ONLY_CHANGED=ref → branch diff         (git diff --name-only ref...HEAD)
  if (!("ONLY_CHANGED" in process.env)) return null;

  let root: string;
  try {
    root = gitRepoRoot();
  } catch {
    root = process.cwd();
  }

  const ref = (process.env.ONLY_CHANGED ?? "").trim();
  const cmd = ref
    ? `git diff --name-only ${ref}...HEAD`
    : "git diff --name-only HEAD";

  try {
    const raw = execSync(cmd, { encoding: "utf8" }).trim();
    const files = raw
      ? raw
          .split("\n")
          .map((f) => path.resolve(root, f.trim()))
          .filter(Boolean)
      : [];
    const label = ref
      ? `${files.length} changed file(s) vs ${ref}`
      : `${files.length} uncommitted changed file(s)`;
    return { files, label };
  } catch {
    const label = ref
      ? `0 changed files vs ${ref} (git error)`
      : `0 uncommitted changed files (git error)`;
    return { files: [], label };
  }
}

const GREY = "\x1b[90m";
const RESET = "\x1b[0m";
const grey = (s: string) => `${GREY}${s}${RESET}`;

// When multiple nodes share the same basename, show parent/basename to disambiguate.
function displayName(nodePath: string, allPaths: Set<string>): string {
  const base = path.basename(nodePath);
  for (const p of allPaths) {
    if (p !== nodePath && path.basename(p) === base) {
      return `${path.basename(path.dirname(nodePath))}/${base}`;
    }
  }
  return base;
}

// Renders only the branches that actually lead to changed files.
// Reachability is computed on the spanning tree (first-visit DFS), so
// back-references are treated as leaves — they only count as "leading to a
// changed file" if they are themselves changed, not via their (un-rendered) subtree.
function renderReducedDepTree(
  root: string,
  adjacency: Map<string, string[]>,
  changedSet: Set<string>,
  allPaths: Set<string>,
): string[] {
  type Node = { path: string; backRef: boolean; children: Node[] };

  // Phase 1: build spanning tree with back-refs as leaves.
  const globalVisited = new Set<string>([root]);
  function buildTree(nodePath: string): Node {
    return {
      path: nodePath,
      backRef: false,
      children: (adjacency.get(nodePath) ?? []).map((childPath) => {
        if (globalVisited.has(childPath)) {
          return { path: childPath, backRef: true, children: [] };
        }
        globalVisited.add(childPath);
        return buildTree(childPath);
      }),
    };
  }

  // Phase 2: reachability on the spanning tree.
  // Back-refs are leaves; they only contribute if they are changed themselves.
  function isReachable(node: Node): boolean {
    if (changedSet.has(node.path)) return true;
    if (node.backRef) return false;
    return node.children.some(isReachable);
  }

  // Phase 3: render pruned spanning tree.
  const lines: string[] = [];
  function render(node: Node, prefix: string, isLast: boolean): void {
    const connector = isLast ? "└── " : "├── ";
    const name = displayName(node.path, allPaths);
    const isChanged = changedSet.has(node.path);
    const label = node.backRef
      ? isChanged
        ? `${name} ↩`
        : grey(`${name} ↩`)
      : isChanged
        ? name
        : grey(name);
    lines.push(prefix + connector + label);
    if (!node.backRef) {
      const visible = node.children.filter(isReachable);
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      visible.forEach((child, i) =>
        render(child, childPrefix, i === visible.length - 1),
      );
    }
  }

  const rootNode = buildTree(root);
  const visible = rootNode.children.filter(isReachable);
  visible.forEach((child, i) => render(child, "  ", i === visible.length - 1));
  return lines;
}

function reportInConsole({
  specPath,
  changedDeps,
  directDeps,
}: SpecReport): void {
  const specName = path.basename(specPath);
  if (changedDeps.length === 0) {
    console.info(`[cypress-only-changed] SKIP  ${specName}`);
    return;
  }
  const changedSet = new Set(changedDeps);
  const allPaths = new Set([
    ...directDeps.keys(),
    ...[...directDeps.values()].flat(),
  ]);
  const treeLines = renderReducedDepTree(
    specPath,
    directDeps,
    changedSet,
    allPaths,
  );
  console.info(
    [`[cypress-only-changed] RUN   ${specName}`, ...treeLines].join("\n"),
  );
}

function buildSkipStub(depCount: number): string {
  const msg = `no changed dependencies — ${depCount} files checked`;
  return `describe('__skipped__', () => { it.skip(${JSON.stringify(msg)}, () => {}); });`;
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
 * Recursively computes the full set of named exports a module provides,
 * following `export * from` chains. Used to replace the old conservative
 * "target has a star re-export, can't tell → pass everything through"
 * fallback that caused false positives in deep barrel trees.
 *
 * Returns 'all' when the set can't be bounded (non-NormalModule, or a
 * star re-export whose target is also unbounded).
 * Uses a cache to avoid redundant work and handle cycles.
 */
function computeProvidedExports(
  module: Module,
  moduleGraph: Compilation["moduleGraph"],
  cache: Map<Module, Set<string> | "all">,
): Set<string> | "all" {
  if (!(module instanceof NormalModule)) return "all";
  const cached = cache.get(module);
  if (cached !== undefined) return cached;

  // Placeholder prevents infinite recursion on cycles.
  const provided = new Set<string>();
  cache.set(module, provided);

  // Map request → target module so we can follow star re-exports.
  const requestToTarget = new Map<string, Module>();
  for (const conn of moduleGraph.getOutgoingConnections(module)) {
    const req = (conn.dependency as any)?.request;
    if (req && conn.module && !requestToTarget.has(req))
      requestToTarget.set(req, conn.module);
  }

  for (const dep of module.dependencies) {
    const d = dep as any;
    if (d.type === "harmony export specifier") {
      if (d.name) provided.add(d.name);
    } else if (d.type === "harmony export imported specifier") {
      if (d.name !== null) {
        if (d.name) provided.add(d.name);
      } else {
        // export * from '...' — recurse into the target.
        const target = requestToTarget.get(d.request);
        if (!target) continue;
        const sub = computeProvidedExports(target, moduleGraph, cache);
        if (sub === "all") {
          cache.set(module, "all");
          return "all";
        }
        for (const name of sub) provided.add(name);
      }
    }
  }

  return provided;
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
 *   • Any `export * from`   → intersect fromNeeded with what target provides
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
  moduleGraph: Compilation["moduleGraph"],
  providedExportsCache: Map<Module, Set<string> | "all">,
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
        const targetProvided =
          target instanceof NormalModule
            ? computeProvidedExports(target, moduleGraph, providedExportsCache)
            : "all";
        if (targetProvided === "all") {
          needed ??= new Set();
          for (const n of fromNeeded) needed.add(n);
        } else {
          for (const n of fromNeeded) {
            if (targetProvided.has(n)) {
              needed ??= new Set();
              needed.add(n);
            }
          }
          // If no intersection, needed stays null → edge pruned below.
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

// Returns true when the spec's direct outgoing connections are CJS requires
// with no harmony imports — meaning ts-loader compiled with "module": "commonjs",
// which prevents tree-shaking of barrel re-exports.
function hasCjsModuleFormat(
  specModule: NormalModule,
  moduleGraph: Compilation["moduleGraph"],
): boolean {
  let hasCjsRequire = false;
  for (const connection of moduleGraph.getOutgoingConnections(specModule)) {
    const type: string | undefined = (connection.dependency as any)?.type;
    if (!type) continue;
    if (HARMONY_TYPES.has(type)) return false;
    if (type === "cjs require") hasCjsRequire = true;
  }
  return hasCjsRequire;
}

function collectTransitiveDeps(
  startModule: NormalModule,
  moduleGraph: Compilation["moduleGraph"],
  isExcluded: (resource: string) => boolean,
): { paths: Set<string>; adjacency: Map<string, string[]> } {
  const providedExportsCache = new Map<Module, Set<string> | "all">();
  const needed = new Map<Module, NeededExports>();
  needed.set(startModule, "all");
  const queue: Module[] = [startModule];
  const paths = new Set<string>();
  const adjSet = new Map<string, Set<string>>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentNeeded = needed.get(current)!;
    const currentPath =
      current instanceof NormalModule && current.resource
        ? current.resource
        : null;

    if (currentPath) paths.add(currentPath);

    // Process each outgoing connection. Harmony deps pointing at the same
    // request share a single decision via computeNeededForRequest(); we
    // dedupe by request so we don't compute it N times.
    const seenHarmonyRequests = new Set<string>();
    const seenNonHarmonyTargets = new Set<Module>();

    for (const connection of moduleGraph.getOutgoingConnections(current)) {
      const target = connection.module;
      if (!target) continue;
      if (
        target instanceof NormalModule &&
        target.resource &&
        isExcluded(target.resource)
      )
        continue;

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
            moduleGraph,
            providedExportsCache,
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

      // Record the followed edge in the adjacency map.
      const targetPath =
        target instanceof NormalModule && target.resource
          ? target.resource
          : null;
      if (currentPath && targetPath) {
        let set = adjSet.get(currentPath);
        if (!set) adjSet.set(currentPath, (set = new Set()));
        set.add(targetPath);
      }

      const { changed, result } = mergeNeeded(needed.get(target), incoming);
      if (changed) {
        needed.set(target, result);
        queue.push(target);
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const [k, v] of adjSet) adjacency.set(k, [...v]);
  return { paths, adjacency };
}

export class CypressOnlyChangedPlugin {
  private readonly changedFiles: Set<string> | null;
  private readonly changedFilesLabel: string | null;
  private readonly report: ((report: SpecReport) => void) | undefined;
  private readonly isExcluded: (resource: string) => boolean;

  constructor({
    report,
    excludedPaths = ["node_modules"],
  }: CypressOnlyChangedPluginOptions = {}) {
    const resolved = resolveChangedFiles();
    if (resolved !== null) {
      this.changedFiles = new Set(resolved.files);
      this.changedFilesLabel = resolved.label;
    } else {
      this.changedFiles = null;
      this.changedFilesLabel = null;
    }
    this.report =
      typeof report === "function"
        ? report
        : report
          ? reportInConsole
          : undefined;
    this.isExcluded =
      excludedPaths.length === 0
        ? () => false
        : (resource) => excludedPaths.some((p) => resource.includes(`/${p}/`));
  }

  apply(compiler: Compiler): void {
    if (this.changedFiles === null) {
      console.info(
        "[cypress-only-changed] ONLY_CHANGED not set — all specs will run",
      );
      return;
    }
    console.info(
      `[cypress-only-changed] ${this.changedFilesLabel} — running affected specs only`,
    );
    compiler.hooks.compilation.tap(
      "CypressOnlyChangedPlugin",
      (compilation: Compilation) => {
        compilation.hooks.finishModules.tapAsync(
          "CypressOnlyChangedPlugin",
          (modules, callback) => {
            try {
              const { moduleGraph } = compilation;
              let cjsWarningEmitted = false;

              for (const module of modules) {
                if (!(module instanceof NormalModule)) continue;
                if (!SPEC_PATTERN.test(module.resource)) continue;

                if (
                  !cjsWarningEmitted &&
                  hasCjsModuleFormat(module, moduleGraph)
                ) {
                  cjsWarningEmitted = true;
                  const w = new WebpackError(
                    "[prune-specs-webpack-plugin] TypeScript files appear to be compiled " +
                      'with "module": "commonjs" — barrel re-exports cannot be tree-shaken ' +
                      "and specs may run unnecessarily when unrelated files change. " +
                      'Configure ts-loader to use "module": "ESNext" or "preserve". ' +
                      "See the plugin README for details.",
                  );
                  w.hideStack = true;
                  compilation.warnings.push(w);
                }

                const { paths: allDeps, adjacency } = collectTransitiveDeps(
                  module,
                  moduleGraph,
                  this.isExcluded,
                );

                const changedDeps: string[] = [];
                for (const depPath of allDeps) {
                  if (this.changedFiles!.has(depPath)) {
                    changedDeps.push(depPath);
                  }
                }

                this.report?.({
                  specPath: module.resource,
                  deps: [...allDeps],
                  changedDeps,
                  directDeps: adjacency,
                });

                if (changedDeps.length === 0) {
                  const stubSource = new sources.RawSource(
                    buildSkipStub(allDeps.size),
                  );
                  const mod = module as NormalModule & { generator: any };
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
