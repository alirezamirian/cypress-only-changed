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
  plugins: [new CypressAffectedPlugin()],
  optimization: {
    usedExports: true,
  },
};

export default config;
