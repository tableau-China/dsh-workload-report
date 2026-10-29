// 发版一致性检查：package.json 版本 == CHANGELOG 条目 == README 声明的版本 == tag（可选）。
// 用法：
//   node test/check-release.mjs            # 只查文件之间是否一致
//   node test/check-release.mjs --tag v2.2.0   # 额外校验 tag 名与版本一致
//
// 为什么需要：右下角版本号只读 package.json，所以"版本号忘了改"从界面上看不出来；
// 这里把三处写死版本号的地方对一遍，发版前跑一次就够。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(ROOT, name), "utf8");

let failures = 0;
const ok = (cond, label, detail = "") => {
  if (cond) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
};

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;

ok(/^\d+\.\d+\.\d+$/.test(version), "package.json 版本是语义化版本", version);

// CHANGELOG：必须有该版本的条目与版本表行
const changelog = read("CHANGELOG.md");
ok(changelog.includes(`## v${version}（`), `CHANGELOG 有 v${version} 的正文条目`);
ok(new RegExp(`\\| \\*\\*${version.replaceAll(".", "\\.")}\\*\\* \\|`).test(changelog), `CHANGELOG 版本表包含 ${version}`);

// README 中英文声明的当前版本
const zh = read("README.zh-CN.md");
const en = read("README.md");
const zhMatch = /当前版本：\*\*([\d.]+)\*\*/.exec(zh);
const enMatch = /Current version: \*\*([\d.]+)\*\*/.exec(en);
ok(zhMatch !== null && zhMatch[1] === version, "README.zh-CN 的「当前版本」与 package.json 一致", zhMatch?.[1]);
ok(enMatch !== null && enMatch[1] === version, "README 的 Current version 与 package.json 一致", enMatch?.[1]);

// CHANGELOG 里不能有比当前版本更高的条目（防止漏发版却写了新版本）
const versions = [...changelog.matchAll(/^## v(\d+\.\d+\.\d+)（/gm)].map((m) => m[1]);
const newer = versions.filter((v) => {
  const a = v.split(".").map(Number);
  const b = version.split(".").map(Number);
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
});
ok(newer.length === 0, "CHANGELOG 没有高于当前版本的条目", newer.join(", "));

// 可选：tag 校验（CI 里用 GITHUB_REF_NAME，本地用 --tag）
const tagArg = process.argv.find((arg) => arg.startsWith("--tag=")) ?? (process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : null);
const tag = tagArg ?? (process.env.GITHUB_REF_NAME?.startsWith("v") ? process.env.GITHUB_REF_NAME : null);
if (tag !== null && tag !== undefined) {
  ok(tag === `v${version}`, `tag ${tag} 与版本 ${version} 一致`, `tag=${tag}`);
}

console.log(failures === 0 ? "\n发版一致性检查通过 ✓" : `\n${failures} 项不一致 ✗`);
process.exit(failures === 0 ? 0 : 1);
