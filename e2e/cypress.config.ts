import { defineConfig } from "cypress";
import * as path from "path";
import * as fs from "fs";
import { CypressAffectedPlugin } from "../src/CypressAffectedPlugin";

export const RAN_SPECS_FILE = path.join(
  path.resolve(__dirname),
  ".ran-specs.json",
);

export default defineConfig({
  reporter: "spec",
  component: {
    devServer: {
      framework: "react",
      bundler: "webpack",
      webpackConfig: async () => {
        const changedFilesEnv = process.env.CHANGED_FILES;
        const changedFiles: string[] = changedFilesEnv
          ? JSON.parse(changedFilesEnv).map((f: string) => path.resolve(f))
          : [];

        return {
          resolve: {
            extensions: [".ts", ".tsx", ".js"],
          },
          module: {
            rules: [
              {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                use: {
                  loader: "ts-loader",
                  options: {
                    configFile: "tsconfig.build.json",
                  },
                },
              },
              {
                test: /\.css$/,
                type: "asset/source",
              },
            ],
          },
          mode: "development",
          plugins: [
            new CypressAffectedPlugin({
              changedFiles,
              report: true,
            }),
          ],
        };
      },
    },
    specPattern: "fixtures/**/*.cy.{ts,tsx}",
    supportFile: "support/component.ts",
    indexHtmlFile: "support/component-index.html",
    setupNodeEvents(on) {
      function readRanSpecs(): string[] {
        try {
          return JSON.parse(
            fs.readFileSync(RAN_SPECS_FILE, "utf8"),
          ) as string[];
        } catch {
          return [];
        }
      }

      function writeRanSpecs(specs: string[]): void {
        fs.writeFileSync(RAN_SPECS_FILE, JSON.stringify(specs), "utf8");
      }

      on("task", {
        recordSpecRan(specName: string) {
          const current = readRanSpecs();
          current.push(specName);
          writeRanSpecs(current);
          return null;
        },
        getRanSpecs() {
          return readRanSpecs();
        },
        clearRanSpecs() {
          writeRanSpecs([]);
          return null;
        },
      });
    },
  },
});
