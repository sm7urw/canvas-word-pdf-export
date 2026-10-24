import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

// Bundled dependencies (jszip -> immediate/setimmediate, pdfmake) ship a legacy
// setImmediate polyfill that injects <script> elements. Modern Obsidian never needs it,
// so swap it for a queueMicrotask-based shim and strip the dead branches.
const noScriptInjection = {
  name: "no-script-injection",
  setup(build) {
    build.onResolve({ filter: /^immediate$/ }, () => ({ path: "immediate", namespace: "shim" }));
    build.onResolve({ filter: /^setimmediate$/ }, () => ({ path: "setimmediate", namespace: "shim" }));
    build.onLoad({ filter: /.*/, namespace: "shim" }, (args) => ({
      contents:
        args.path === "immediate"
          ? "module.exports = function (fn) { queueMicrotask(fn); };"
          : "",
      loader: "js",
    }));
    build.onLoad({ filter: /node_modules[\\/].*\.[cm]?js$/ }, async (args) => {
      const fs = await import("node:fs/promises");
      const text = await fs.readFile(args.path, "utf8");
      const re = /createElement\((["'])script\1\)|\bin\s+(\w+)\((["'])script\3\)/g;
      if (!re.test(text)) return null;
      re.lastIndex = 0;
      const out = text.replace(re, (m, _q, fn) => (fn ? `in ${fn}("span")` : 'createElement("span")'));
      return { contents: out, loader: "js" };
    });
  },
};

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [noScriptInjection],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
  define: { "process.env.NODE_ENV": prod ? "\"production\"" : "\"development\"" },
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
