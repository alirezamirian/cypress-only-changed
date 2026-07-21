import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { globSync } from "glob";
import webpack from "webpack";
import type {
  Compiler,
  Compilation,
  Configuration,
  Module,
} from "webpack";
import { NormalModule, WebpackError, sources } from "webpack";

export interface SpecLog {
  specPath: string;
  deps: string[];
  changedDeps: string[];
  directDeps: Map<string, string[]>; // adjacency: path → its direct followed dep paths
}

export type BuiltinLoggerName = "minimal" | "verbose" | "github-actions";
export type LoggerEntry = BuiltinLoggerName | ((specLog: SpecLog) => void);

interface CypressOnlyChangedPluginOptions {
  log?: false | LoggerEntry | LoggerEntry[];
  excludedPaths?: string[];
}

function gitRepoRoot(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

export interface ResolvedChangedFiles {
  files: string[];
  label: string; // human-readable description for the startup log
}

export function resolveChangedFiles(): ResolvedChangedFiles | null {
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

function logMinimal({ specPath, changedDeps }: SpecLog): void {
  const specName = path.basename(specPath);
  if (changedDeps.length === 0) {
    console.info(`[cypress-only-changed] SKIP  ${specName}`);
  } else {
    const n = changedDeps.length;
    console.info(
      `[cypress-only-changed] RUN   ${specName}  (${n} changed dep${n === 1 ? "" : "s"})`,
    );
  }
}

function logVerbose({ specPath, changedDeps, directDeps }: SpecLog): void {
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

const _ghaBuffer: SpecLog[] = [];
let _ghaRegistered = false;

function buildGhaMarkdown(entries: SpecLog[]): string {
  const rows = entries.map(({ specPath, changedDeps }) => {
    const name = path.basename(specPath);
    const status = changedDeps.length === 0 ? "⏭ skip" : "▶ run";
    let deps = "—";
    if (changedDeps.length > 0) {
      const MAX = 3;
      const names = changedDeps.map((f) => `\`${path.basename(f)}\``);
      deps =
        names.length <= MAX
          ? names.join(", ")
          : `${names[0]} and ${names.length - 1} more`;
    }
    return `| \`${name}\` | ${status} | ${deps} |`;
  });
  return [
    "## Cypress component tests — affected-specs summary",
    "",
    "| Spec | Status | Changed dependencies |",
    "|---|:---:|---|",
    ...rows,
    "\n",
  ].join("\n");
}

function githubActionsLogger(specLog: SpecLog): void {
  _ghaBuffer.push(specLog);
  if (!_ghaRegistered) {
    _ghaRegistered = true;
    process.on("exit", () => {
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (!summaryFile) return;
      fs.appendFileSync(summaryFile, buildGhaMarkdown(_ghaBuffer), "utf8");
    });
  }
}

function resolveLogger(
  opt: CypressOnlyChangedPluginOptions["log"],
): ((specLog: SpecLog) => void)[] {
  if (opt === false) return [];
  if (opt === undefined) return [logMinimal];
  const entries: LoggerEntry[] = Array.isArray(opt) ? opt : [opt];
  return entries.map((entry) => {
    if (typeof entry === "function") return entry;
    if (entry === "minimal") return logMinimal;
    if (entry === "verbose") return logVerbose;
    if (entry === "github-actions") return githubActionsLogger;
    const _: never = entry;
    throw new Error(`[cypress-only-changed] Unknown logger: "${entry}"`);
  });
}

function buildSkipStub(depCount: number): string {
  const msg = `no changed dependencies — ${depCount} files checked`;
  return `describe('__skipped__', () => { it.skip(${JSON.stringify(msg)}, () => {}); });`;
}

export const SPEC_PATTERN = /\.cy\.(ts|tsx)$/;

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

export function collectTransitiveDeps(
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
  private readonly loggers: ((specLog: SpecLog) => void)[];
  private readonly isExcluded: (resource: string) => boolean;

  constructor({
    log,
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
    this.loggers = resolveLogger(log);
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

                const specLog: SpecLog = {
                  specPath: module.resource,
                  deps: [...allDeps],
                  changedDeps,
                  directDeps: adjacency,
                };
                for (const r of this.loggers) r(specLog);

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

export interface ComputeAffectedSpecsOptions {
  /**
   * The webpack configuration used to build the specs (same loaders/resolve
   * settings as your Cypress dev-server config). Any `CypressOnlyChangedPlugin`
   * instance in `plugins` is ignored — this analysis only needs the module
   * graph, not stubbing.
   */
  webpackConfig: Configuration;
  /** Absolute paths of every spec file to consider. */
  specs: string[];
  /**
   * Directory names to exclude from the dependency walk.
   * @default ["node_modules"]
   */
  excludedPaths?: string[];
  /**
   * Explicit list of changed files (absolute paths). When omitted, the same
   * `ONLY_CHANGED` git resolution as the plugin is used (via
   * {@link resolveChangedFiles}).
   */
  changedFiles?: string[];
  /**
   * Per-spec logging — the **same** options as the {@link CypressOnlyChangedPlugin}
   * `log` option: `"minimal"` (one `RUN`/`SKIP` line per spec), `"verbose"` (adds
   * an ASCII dependency tree for affected specs), `"github-actions"` (a Markdown
   * summary table to `$GITHUB_STEP_SUMMARY`), a custom `(specLog) => void`, or an
   * array combining any of these. Unlike the plugin (which defaults to
   * `"minimal"`), this defaults to **`false`** (silent) so the programmatic API
   * stays quiet unless you opt in.
   * @default false
   */
  log?: false | LoggerEntry | LoggerEntry[];
}

/**
 * Computes, up front, the set of specs that transitively depend on a changed
 * file — using the exact same tree-shaking-aware dependency walk as the
 * {@link CypressOnlyChangedPlugin}. A single webpack pass is run with every
 * spec as an entry; no output is emitted.
 *
 * Unlike the plugin (which lets every spec run and replaces unaffected ones
 * with a stub), this lets you exclude unaffected specs from the Cypress run
 * entirely — e.g. by restricting `specPattern` in `setupNodeEvents` — so the
 * browser is never launched for them. That removes Cypress's fixed per-spec
 * orchestration overhead, which dominates when most specs are unaffected.
 *
 * @returns
 *   - `null`  → `ONLY_CHANGED` is not set (and no `changedFiles` given): the
 *               caller should run every spec, exactly like the plugin no-op.
 *   - `[]`    → nothing is affected: the caller should run zero specs.
 *   - `string[]` → absolute paths of the specs that must run.
 */
export async function computeAffectedSpecs(
  options: ComputeAffectedSpecsOptions,
): Promise<string[] | null> {
  const { webpackConfig, specs, excludedPaths = ["node_modules"] } = options;
  const loggers = resolveLogger(options.log ?? false);

  let changed: Set<string> | null;
  if (options.changedFiles) {
    changed = new Set(options.changedFiles);
  } else {
    const resolved = resolveChangedFiles();
    changed = resolved ? new Set(resolved.files) : null;
  }
  if (changed === null) return null; // ONLY_CHANGED not set → run all
  if (specs.length === 0) return [];

  const isExcluded =
    excludedPaths.length === 0
      ? () => false
      : (resource: string) =>
          excludedPaths.some((p) => resource.includes(`/${p}/`));

  // Every spec becomes its own entry so the graph pass mirrors what Cypress
  // builds per spec, while sharing module builds across specs for speed.
  const entry: Record<string, string> = {};
  specs.forEach((spec, i) => {
    entry[`spec_${i}`] = spec;
  });

  // Drop any CypressOnlyChangedPlugin instance — we only need the module graph,
  // and stubbing here would be pointless. Keep every other plugin so resolution
  // matches the real build.
  const plugins = (webpackConfig.plugins ?? []).filter(
    (p) =>
      !p ||
      !p.constructor ||
      p.constructor.name !== "CypressOnlyChangedPlugin",
  );

  const config: Configuration = {
    ...webpackConfig,
    entry,
    mode: "development",
    devtool: false,
    plugins,
    output: {
      ...(webpackConfig.output ?? {}),
      path: path.join(os.tmpdir(), "cypress-only-changed-analysis"),
    },
    optimization: {
      ...(webpackConfig.optimization ?? {}),
      minimize: false,
      splitChunks: false,
      runtimeChunk: false,
      removeAvailableModules: false,
      removeEmptyChunks: false,
      concatenateModules: false,
      sideEffects: false,
    },
    stats: "errors-only",
  };

  return await new Promise<string[]>((resolve, reject) => {
    const compiler = webpack(config);

    compiler.hooks.compilation.tap("ComputeAffectedSpecs", (compilation) => {
      compilation.hooks.finishModules.tap("ComputeAffectedSpecs", (modules) => {
        const { moduleGraph } = compilation;
        const affected = new Set<string>();
        for (const module of modules) {
          if (!(module instanceof NormalModule)) continue;
          if (!SPEC_PATTERN.test(module.resource)) continue;
          const { paths, adjacency } = collectTransitiveDeps(
            module,
            moduleGraph,
            isExcluded,
          );
          const changedDeps: string[] = [];
          for (const depPath of paths) {
            if (changed!.has(depPath)) changedDeps.push(depPath);
          }
          if (loggers.length > 0) {
            const specLog: SpecLog = {
              specPath: module.resource,
              deps: [...paths],
              changedDeps,
              directDeps: adjacency,
            };
            for (const log of loggers) log(specLog);
          }
          if (changedDeps.length > 0) affected.add(module.resource);
        }
        (compiler as unknown as { __affected: Set<string> }).__affected =
          affected;
      });
    });

    compiler.run((err, stats) => {
      compiler.close(() => {
        /* ignore close errors */
      });
      if (err) return reject(err);
      if (stats && stats.hasErrors()) {
        return reject(new Error(stats.toString("errors-only")));
      }
      const found =
        (compiler as unknown as { __affected?: Set<string> }).__affected ??
        new Set<string>();
      resolve([...found]);
    });
  });
}

/**
 * The subset of Cypress's resolved config (`Cypress.PluginConfigOptions`) that
 * spec filtering reads. Declared structurally — rather than importing Cypress's
 * types — so the package doesn't take a hard dependency on `cypress`, while
 * still letting `filterOnlyChangedSpecs(config)` accept the real config object
 * and return it unchanged (via the generic below). Intentionally has **no**
 * index signature: an index signature would stop `PluginConfigOptions` (an
 * interface) from being assignable to it.
 */
export interface CypressSpecConfig {
  /** Cypress `config.projectRoot` — base directory for resolving `specPattern`. */
  projectRoot: string;
  /** Cypress `config.specPattern` — glob(s) of spec files. */
  specPattern: string | string[];
  /** Cypress `config.excludeSpecPattern` — glob(s) of specs to exclude. */
  excludeSpecPattern?: string | string[];
  /**
   * Cypress component-testing dev server. Not present on the top-level
   * `PluginConfigOptions` *type* (it lives under `component.devServer`), but
   * the resolved config passed to `setupNodeEvents` does expose it at runtime —
   * so we read it opportunistically. Optional, so it never blocks assignment.
   */
  devServer?: {
    webpackConfig?:
      | Configuration
      | (() => Configuration | Promise<Configuration>);
  };
}

export interface FilterOnlyChangedSpecsOptions {
  /**
   * The webpack configuration used to build the specs. **Optional** — when
   * omitted it is read from `config.devServer.webpackConfig` (resolving it if
   * it's a function). Pass this only to override, or when your dev server
   * doesn't expose a plain webpack config. Any `CypressOnlyChangedPlugin` in
   * `plugins` is ignored.
   */
  webpackConfig?: Configuration;
  /**
   * Directory names to exclude from the dependency walk.
   * @default ["node_modules"]
   */
  excludedPaths?: string[];
  /**
   * Explicit list of changed files (absolute paths). When omitted, the same
   * `ONLY_CHANGED` git resolution as the plugin is used.
   */
  changedFiles?: string[];
  /**
   * File name of the generated placeholder spec used when nothing is affected
   * (written under the OS temp dir). Cypress errors on an empty spec set, so a
   * single trivial spec keeps the exit code at 0.
   * @default "no-affected-specs.cy.js"
   */
  placeholderSpecName?: string;
  /**
   * Per-spec logging — the **same** options as the {@link CypressOnlyChangedPlugin}
   * `log` option: `"minimal"`, `"verbose"` (prints an ASCII dependency tree for
   * each affected spec, showing the changed deps that pulled it in),
   * `"github-actions"`, a custom `(specLog) => void`, or an array of these.
   * Independent of the one-line summary this function always prints. Defaults to
   * `false` (no per-spec output).
   * @default false
   */
  log?: false | LoggerEntry | LoggerEntry[];
}

function toArray(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Discovers spec files exactly the way Cypress would — globbing
 * `config.specPattern` from `config.projectRoot`, honoring
 * `config.excludeSpecPattern`, matching files only (so directories named like
 * specs, e.g. image-snapshot folders, are ignored), and always excluding
 * `node_modules`.
 */
export function discoverSpecs(config: CypressSpecConfig): string[] {
  const patterns = toArray(config.specPattern);
  if (patterns.length === 0) return [];
  const ignore = [...toArray(config.excludeSpecPattern), "**/node_modules/**"];
  return globSync(patterns, {
    cwd: config.projectRoot,
    absolute: true,
    ignore,
    nodir: true,
  });
}

function writePlaceholderSpec(
  name = "no-affected-specs.cy.js",
): string {
  const dir = path.join(os.tmpdir(), "cypress-only-changed");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    "describe('cypress-only-changed: no affected specs', function () {\n" +
      "  it('nothing to run for the current change set', function () {});\n" +
      "});\n",
  );
  return file;
}

async function resolveWebpackConfig(
  config: CypressSpecConfig,
  options: FilterOnlyChangedSpecsOptions,
): Promise<Configuration> {
  if (options.webpackConfig) return options.webpackConfig;
  const fromConfig = config.devServer?.webpackConfig;
  if (!fromConfig) {
    throw new Error(
      "[cypress-only-changed] no webpack config found — pass " +
        "`webpackConfig` in options, or ensure `config.devServer.webpackConfig` " +
        "is set (webpack bundler).",
    );
  }
  return typeof fromConfig === "function" ? await fromConfig() : fromConfig;
}

/**
 * The batteries-included, config-driven entry point. Call it from Cypress
 * `setupNodeEvents` and hand back the config it returns:
 *
 * ```ts
 * async setupNodeEvents(on, config) {
 *   return filterOnlyChangedSpecs(config);
 * }
 * ```
 *
 * It reads everything it needs from the Cypress `config`:
 *   - specs from `config.specPattern` / `config.excludeSpecPattern` (no need to
 *     pass a spec list yourself), and
 *   - the webpack config from `config.devServer.webpackConfig` (override via
 *     `options.webpackConfig` if needed).
 *
 * It computes which specs are affected — using the same tree-shaking-aware
 * analysis as {@link CypressOnlyChangedPlugin} — and rewrites
 * `config.specPattern` so Cypress runs **only** the affected specs, never
 * launching a browser for the rest. When nothing is affected it points Cypress
 * at an internally-generated placeholder spec (so the run still exits 0). When
 * `ONLY_CHANGED` is not set it leaves the config untouched, so every spec runs.
 *
 * @returns the same `config` object (mutated), for chaining/returning.
 */
export async function filterOnlyChangedSpecs<T extends CypressSpecConfig>(
  config: T,
  options: FilterOnlyChangedSpecsOptions = {},
): Promise<T> {
  let changedFiles: string[] | null;
  if (options.changedFiles) {
    changedFiles = options.changedFiles;
  } else {
    const resolved = resolveChangedFiles();
    changedFiles = resolved ? resolved.files : null;
  }

  if (changedFiles === null) {
    // ONLY_CHANGED not set → run everything, exactly like the plugin no-op.
    console.info(
      "[cypress-only-changed] ONLY_CHANGED not set — all specs will run",
    );
    return config;
  }

  const specs = discoverSpecs(config);

  // Nothing changed at all → nothing can be affected; skip the webpack pass.
  if (changedFiles.length === 0) {
    config.specPattern = writePlaceholderSpec(options.placeholderSpecName);
    console.info(
      `[cypress-only-changed] spec filtering: 0/${specs.length} spec(s) affected — running a placeholder`,
    );
    return config;
  }

  const affected = await computeAffectedSpecs({
    webpackConfig: await resolveWebpackConfig(config, options),
    specs,
    excludedPaths: options.excludedPaths,
    changedFiles,
    log: options.log,
  });

  if (affected && affected.length > 0) {
    config.specPattern = affected;
    console.info(
      `[cypress-only-changed] spec filtering: ${affected.length}/${specs.length} spec(s) affected`,
    );
  } else {
    config.specPattern = writePlaceholderSpec(options.placeholderSpecName);
    console.info(
      `[cypress-only-changed] spec filtering: 0/${specs.length} spec(s) affected — running a placeholder`,
    );
  }

  return config;
}
