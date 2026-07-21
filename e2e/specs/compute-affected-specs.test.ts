import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import type { Configuration } from "webpack";
import {
  computeAffectedSpecs,
  discoverSpecs,
  filterOnlyChangedSpecs,
} from "../../src/CypressOnlyChangedPlugin";

// These tests exercise `computeAffectedSpecs` — the spec-level-filtering
// counterpart of the stubbing plugin — directly against the same fixtures used
// by the plugin's Cypress e2e tests. Because both share the exact same
// tree-shaking-aware dependency walk (`collectTransitiveDeps`), asserting the
// same expected affected sets here doubles as a regression guard for that
// shared logic. Unlike the plugin tests, this needs only webpack (no Cypress
// browser), so it runs anywhere.

const fixturesDir = path.resolve(__dirname, "../fixtures");
const buildTsconfig = path.resolve(__dirname, "../../tsconfig.build.json");

function analysisWebpackConfig(): Configuration {
  return {
    context: fixturesDir,
    resolve: { extensions: [".ts", ".tsx", ".js"] },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: "ts-loader",
            // transpileOnly: we only need the (ESM) module graph, not type
            // checking. Keeps `module: ESNext` so barrel re-exports stay
            // tree-shakeable, exactly like the plugin's build.
            options: { configFile: buildTsconfig, transpileOnly: true },
          },
        },
        { test: /\.css$/, type: "asset/source" },
      ],
    },
  };
}

function specFilesFor(fixture: string): string[] {
  const dir = path.join(fixturesDir, fixture);
  return fs
    .readdirSync(dir)
    .filter((f) => /\.cy\.(ts|tsx)$/.test(f))
    .map((f) => path.join(dir, f));
}

/** Absolute paths of the affected specs, as sorted basenames for easy asserts. */
async function affectedBasenames(
  fixture: string,
  changed: string[],
): Promise<string[]> {
  const specs = specFilesFor(fixture);
  const changedFiles = changed.map((c) =>
    path.join(fixturesDir, fixture, c),
  );
  const result = await computeAffectedSpecs({
    webpackConfig: analysisWebpackConfig(),
    specs,
    changedFiles,
  });
  assert.ok(result !== null, "expected a spec list, not null");
  return (result as string[]).map((p) => path.basename(p)).sort();
}

function assertAffected(actual: string[], expected: string[]): void {
  assert.deepEqual(actual, [...expected].sort());
}

describe("computeAffectedSpecs — basic", { concurrency: false }, () => {
  it("no files changed — nothing affected", async () => {
    assertAffected(await affectedBasenames("basic", []), []);
  });

  it("spec file itself changed — only that spec", async () => {
    assertAffected(await affectedBasenames("basic", ["Button.cy.tsx"]), [
      "Button.cy.tsx",
    ]);
  });

  it("Button.tsx changed — Button and Form", async () => {
    assertAffected(await affectedBasenames("basic", ["Button.tsx"]), [
      "Button.cy.tsx",
      "Form.cy.tsx",
    ]);
  });

  it("Input.tsx changed — Input and Form", async () => {
    assertAffected(await affectedBasenames("basic", ["Input.tsx"]), [
      "Input.cy.tsx",
      "Form.cy.tsx",
    ]);
  });

  it("Input.tsx + format.ts changed — Input, Form, and utils", async () => {
    assertAffected(
      await affectedBasenames("basic", ["Input.tsx", "format.ts"]),
      ["Input.cy.tsx", "Form.cy.tsx", "utils.cy.ts"],
    );
  });

  it("config.ts changed — only config", async () => {
    assertAffected(await affectedBasenames("basic", ["config.ts"]), [
      "config.cy.ts",
    ]);
  });
});

describe("computeAffectedSpecs — barrel-exports", { concurrency: false }, () => {
  it("no files changed — nothing affected", async () => {
    assertAffected(await affectedBasenames("barrel-exports", []), []);
  });

  it("Input.tsx changed — only Input (Button tree-shaken)", async () => {
    assertAffected(await affectedBasenames("barrel-exports", ["Input.tsx"]), [
      "Input.cy.tsx",
    ]);
  });

  it("Button.tsx changed — only Button (Input tree-shaken)", async () => {
    assertAffected(await affectedBasenames("barrel-exports", ["Button.tsx"]), [
      "Button.cy.tsx",
    ]);
  });

  it("utils.ts changed — nothing affected", async () => {
    assertAffected(await affectedBasenames("barrel-exports", ["utils.ts"]), []);
  });

  it(
    "utils-barrel.ts changed — nothing uses it (FAILS: export * false positive)",
    { skip: "Known limitation — mirrors barrel-exports.test.ts" },
    async () => {
      assertAffected(
        await affectedBasenames("barrel-exports", ["utils-barrel.ts"]),
        [],
      );
    },
  );
});

describe("computeAffectedSpecs — css-import", { concurrency: false }, () => {
  it("no files changed — nothing affected", async () => {
    assertAffected(await affectedBasenames("css-import", []), []);
  });

  it("Button.css changed — only Button (Label has no CSS dep)", async () => {
    assertAffected(await affectedBasenames("css-import", ["Button.css"]), [
      "Button.cy.tsx",
    ]);
  });
});

describe("computeAffectedSpecs — run-all signal", { concurrency: false }, () => {
  it("returns null when ONLY_CHANGED is unset and no changedFiles given", async () => {
    const hadOnlyChanged = "ONLY_CHANGED" in process.env;
    const prev = process.env.ONLY_CHANGED;
    delete process.env.ONLY_CHANGED;
    try {
      const result = await computeAffectedSpecs({
        webpackConfig: analysisWebpackConfig(),
        specs: specFilesFor("basic"),
      });
      assert.equal(result, null);
    } finally {
      if (hadOnlyChanged) process.env.ONLY_CHANGED = prev;
    }
  });
});

describe("discoverSpecs", { concurrency: false }, () => {
  it("globs specPattern from projectRoot", () => {
    const specs = discoverSpecs({
      projectRoot: path.join(fixturesDir, "basic"),
      specPattern: "**/*.cy.{ts,tsx}",
    });
    const names = specs.map((s) => path.basename(s)).sort();
    assert.deepEqual(names, [
      "Button.cy.tsx",
      "Form.cy.tsx",
      "Input.cy.tsx",
      "config.cy.ts",
      "utils.cy.ts",
    ]);
  });

  it("honors excludeSpecPattern", () => {
    const specs = discoverSpecs({
      projectRoot: path.join(fixturesDir, "basic"),
      specPattern: "**/*.cy.{ts,tsx}",
      excludeSpecPattern: "**/Button.cy.tsx",
    });
    const names = specs.map((s) => path.basename(s));
    assert.ok(!names.includes("Button.cy.tsx"));
    assert.ok(names.includes("Form.cy.tsx"));
  });

  it("matches files only — a directory named like a spec is ignored", () => {
    const root = fs.mkdtempSync(path.join(require("os").tmpdir(), "coc-disc-"));
    try {
      fs.mkdirSync(path.join(root, "Snap.cy.tsx")); // a directory, not a file
      fs.writeFileSync(path.join(root, "Real.cy.tsx"), "");
      const specs = discoverSpecs({
        projectRoot: root,
        specPattern: "**/*.cy.{ts,tsx}",
      });
      const names = specs.map((s) => path.basename(s));
      assert.deepEqual(names, ["Real.cy.tsx"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("filterOnlyChangedSpecs", { concurrency: false }, () => {
  function baseConfig(fixture: string) {
    return {
      projectRoot: path.join(fixturesDir, fixture),
      specPattern: "**/*.cy.{ts,tsx}",
      devServer: { webpackConfig: analysisWebpackConfig() },
    };
  }

  it("null changes (ONLY_CHANGED unset) — config untouched (run all)", async () => {
    const hadOnlyChanged = "ONLY_CHANGED" in process.env;
    const prev = process.env.ONLY_CHANGED;
    delete process.env.ONLY_CHANGED;
    try {
      const config = baseConfig("basic");
      const original = config.specPattern;
      const out = await filterOnlyChangedSpecs(config);
      assert.equal(out.specPattern, original);
    } finally {
      if (hadOnlyChanged) process.env.ONLY_CHANGED = prev;
    }
  });

  it("nothing affected — specPattern rewritten to a placeholder spec", async () => {
    const config = baseConfig("basic");
    const out = await filterOnlyChangedSpecs(config, { changedFiles: [] });
    assert.equal(typeof out.specPattern, "string");
    assert.match(out.specPattern as string, /no-affected-specs\.cy\.js$/);
    assert.ok(fs.existsSync(out.specPattern as string));
  });

  it("Button.tsx changed — specPattern is exactly Button + Form specs", async () => {
    const config = baseConfig("basic");
    const out = await filterOnlyChangedSpecs(config, {
      changedFiles: [path.join(fixturesDir, "basic", "Button.tsx")],
    });
    assert.ok(Array.isArray(out.specPattern));
    const names = (out.specPattern as string[])
      .map((s) => path.basename(s))
      .sort();
    assert.deepEqual(names, ["Button.cy.tsx", "Form.cy.tsx"]);
  });

  it("reads webpackConfig from config.devServer.webpackConfig (no option)", async () => {
    // baseConfig puts the webpack config only on devServer; no webpackConfig
    // option is passed, so this asserts the config-driven resolution path.
    const config = baseConfig("barrel-exports");
    const out = await filterOnlyChangedSpecs(config, {
      changedFiles: [path.join(fixturesDir, "barrel-exports", "Input.tsx")],
    });
    assert.ok(Array.isArray(out.specPattern));
    const names = (out.specPattern as string[]).map((s) => path.basename(s));
    assert.deepEqual(names, ["Input.cy.tsx"]);
  });
});
