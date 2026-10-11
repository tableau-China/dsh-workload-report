// 构建 lib/client.js：把 src/client/ 打包成 DSH 客户端插件要求的 ModuleLoader 工厂格式。
// 用法：node build.mjs
//
// esbuild 解析顺序（本项目不强制自带 node_modules）：
//   1) $ESBUILD_PATH                       2) 本目录 node_modules/esbuild
//   3) Node 的常规解析（含全局安装）
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** 找到 esbuild 的入口文件。 */
function loadEsbuild() {
  const candidates = [
    typeof process.env.ESBUILD_PATH === "string" && process.env.ESBUILD_PATH.length > 0 ? process.env.ESBUILD_PATH : null,
    join(here, "node_modules", "esbuild", "lib", "main.js"),
  ].filter((candidate) => candidate !== null);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return require.resolve("esbuild");
  } catch {
    throw new Error(
      `找不到 esbuild。请任选其一：\n` +
        `  1) pnpm add -D esbuild（推荐）\n` +
        `  2) ESBUILD_PATH=/path/to/esbuild/lib/main.js node build.mjs\n`,
    );
  }
}

const esbuildPath = loadEsbuild();
const esbuild = await import(pathToFileURL(esbuildPath).href);
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const ID = pkg.name;

const result = await esbuild.build({
  entryPoints: [join(here, "src", "client", "index.jsx")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "text" },
  // react / react-dom 与所有 @deepseek-ai/* 共享模块由宿主 shell 提供，不打进包
  external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/*"],
  write: false,
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});

const body = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`;

writeFileSync(join(here, "lib", "client.js"), wrapped);
console.log(`lib/client.js 已生成（${(wrapped.length / 1024).toFixed(1)} KB，esbuild ${esbuild.version}）`);
