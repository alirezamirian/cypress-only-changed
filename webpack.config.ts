import * as path from "path";
import { Configuration } from "webpack";
import { CypressAffectedPlugin } from "./src/CypressAffectedPlugin";

const config: Configuration = {
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new CypressAffectedPlugin({
      changedFiles: process.env.CHANGED_FILES
        ? JSON.parse(process.env.CHANGED_FILES).map((f: string) =>
            path.resolve(f),
          )
        : [],
    }),
  ],
  optimization: {
    usedExports: true,
  },
};

export default config;
