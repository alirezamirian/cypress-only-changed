import { Configuration } from "webpack";
import { CypressOnlyChangedPlugin } from "./src/CypressOnlyChangedPlugin";

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
  plugins: [new CypressOnlyChangedPlugin()],
  optimization: {
    usedExports: true,
  },
};

export default config;
