import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";

const banner = `/*
Vault Linker — Obsidian plugin (bundled, generated file — do not edit).
Source: https://github.com/goldenxingxing/obsidian-vault-linker
*/`;

const context = await esbuild.context({
  entryPoints: ["src/obsidian/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    "node:*",
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  banner: { js: banner },
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
