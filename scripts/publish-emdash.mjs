#!/usr/bin/env node
/**
 * 把 docs/blog.md 发布到 EmDash 博客（vizwise.cn）。
 *
 * 用法：
 *   EMDASH_TOKEN=ec_pat_xxx node scripts/publish-emdash.mjs --site https://vizwise.cn [--dry-run] [--post <id>]
 *
 * 做的事：
 *   1. 解析 front-matter（title/date/tags）
 *   2. Markdown → Portable Text（标题/段落/引用/列表/代码块/表格/图片/加粗/行内代码/链接）
 *   3. 上传正文引用的图片到媒体库，替换为媒体引用
 *   4. 建草稿（或更新已有草稿）→ 发布
 *
 * 依赖：Node 22+（内置 fetch / FormData / Blob），无需 npm 依赖。
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const SITE = (option("--site", process.env.EMDASH_SITE) ?? "").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN ?? "";
const DRY = flag("--dry-run");
const POST_ID = option("--post");
const FILE = option("--file", join(ROOT, "docs", "blog.md"));
if (!SITE) throw new Error("缺少 --site（例如 https://vizwise.cn）");

const api = (path, init = {}) =>
  fetch(`${SITE}/_emdash/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });

let keyCounter = 0;
const key = (prefix = "b") => `${prefix}${(keyCounter += 1).toString(36)}`;

/** 把一段文本里的 `**加粗**`、\`行内代码\`、[链接](url) 解析成 span 数组与 markDefs。 */
function inline(text, markDefs) {
  const spans = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let match;
  const push = (value, marks) => {
    if (value === "") return;
    spans.push({ _type: "span", _key: key("s"), text: value, marks });
  };
  while ((match = pattern.exec(text)) !== null) {
    push(text.slice(last, match.index), []);
    if (match[1] !== undefined) push(match[1], ["strong"]);
    else if (match[2] !== undefined) push(match[2], ["code"]);
    else {
      const def = { _type: "link", _key: key("l"), href: match[4], blank: false };
      markDefs.push(def);
      push(match[3], [def._key]);
    }
    last = match.index + match[0].length;
  }
  push(text.slice(last), []);
  return spans.length > 0 ? spans : [{ _type: "span", _key: key("s"), text, marks: [] }];
}

/** 一行 Markdown → 一个 PT 块（不含表格/代码/图片，它们由外层识别）。 */
function textBlock(line, extra = {}) {
  const markDefs = [];
  return { _type: "block", _key: key(), style: "normal", markDefs, children: inline(line, markDefs), ...extra };
}

/** Markdown 表格 → PT table 块（单元格同样解析行内标记）。 */
function tableBlock(rows) {
  const markDefs = [];
  const cells = (text, isHeader) => ({
    _type: "tableCell",
    _key: key("c"),
    content: inline(text.trim(), markDefs),
    ...(isHeader ? { isHeader: true } : {}),
  });
  const [head, ...body] = rows;
  // 第二行是 |---| 分隔行，跳过
  const bodyRows = body.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c.trim())));
  return {
    _type: "table",
    _key: key("t"),
    ...(markDefs.length > 0 ? { markDefs } : {}),
    rows: [
      { _type: "tableRow", _key: key("r"), cells: head.map((c) => cells(c, true)) },
      ...bodyRows.map((r) => ({ _type: "tableRow", _key: key("r"), cells: r.map((c) => cells(c, false)) })),
    ],
  };
}

/** 解析 Markdown 正文 → Portable Text 块数组。 */
export function markdownToPortableText(markdown, { assetFor = () => null } = {}) {
  // <!-- publish:skip --> … <!-- /publish:skip --> 之间的内容不进正文（例如站点自带署名时重复的作者卡片）
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .replace(/<!-- publish:skip -->[\s\S]*?<!-- \/publish:skip -->/g, "")
    .split("\n");
  const blocks = [];
  let i = 0;
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      blocks.push({ _type: "code", _key: key("code"), code: body.join("\n"), ...(lang ? { language: lang } : {}) });
      continue;
    }

    // 表格
    if (isTableRow(line)) {
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i].split("|").slice(1, -1));
        i += 1;
      }
      blocks.push(tableBlock(rows));
      continue;
    }

    // 图片
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (image !== null) {
      const asset = assetFor(image[2]);
      blocks.push({
        _type: "image",
        _key: key("img"),
        alt: image[1],
        ...(asset
          ? { asset: { _type: "reference", _ref: asset.id, url: asset.url }, width: asset.width, height: asset.height, blurhash: asset.blurhash, dominantColor: asset.dominantColor }
          : { asset: { _type: "reference", _ref: "", url: image[2] } }),
      });
      i += 1;
      continue;
    }

    // 标题
    const heading = line.match(/^(#{2,4})\s+(.*)$/);
    if (heading !== null) {
      blocks.push(textBlock(heading[2], { style: `h${heading[1].length}` }));
      i += 1;
      continue;
    }

    // 引用（连续 > 行合成一块）
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(textBlock(quote.join(" "), { style: "blockquote" }));
      continue;
    }

    // 列表
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet !== null || numbered !== null) {
      blocks.push(textBlock((bullet ?? numbered)[1], { listItem: bullet !== null ? "bullet" : "number", level: 1 }));
      i += 1;
      continue;
    }

    // 空行 / HTML 块（作者卡片等）
    if (line.trim() === "" || /^\s*</.test(line) || /^\s*---\s*$/.test(line) || /^\s*\|?\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // 普通段落（连续非空行合成一段）
    const paragraph = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{2,4}\s|>|\s*[-*]\s|\s*\d+\.\s|\s*```)/.test(lines[i]) && !isTableRow(lines[i]) && !/^!\[/.test(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push(textBlock(paragraph.join(" ")));
  }
  return blocks;
}

/** 解析 front-matter。 */
function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (match === null) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv !== null) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: text.slice(match[0].length) };
}

/** 上传一张图片，返回媒体对象。 */
async function uploadImage(filePath, alt) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), basename(filePath));
  if (alt) form.append("alt", alt);
  const response = await api("/media", { method: "POST", body: form });
  const json = await response.json();
  if (!response.ok || json.success === false) throw new Error(`上传失败 ${filePath}: ${JSON.stringify(json).slice(0, 200)}`);
  return json.data?.item ?? json.data?.media ?? json.data;
}

const raw = await readFile(FILE, "utf8");
const { meta, body } = parseFrontMatter(raw);
const title = meta.title ?? basename(FILE);

// 1) 上传正文引用的图片（dry-run 时跳过）
const cache = new Map();
const assetFor = (href) => cache.get(href) ?? null;
const images = [...new Set([...body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((m) => ({ alt: m[1], href: m[2] })))];
if (!DRY) {
  for (const image of images) {
    const filePath = resolve(ROOT, "docs", image.href);
    const asset = await uploadImage(filePath, image.alt);
    cache.set(image.href, asset);
    console.log(`  上传图片 ${image.href} → ${asset.id}`);
  }
}

const content = markdownToPortableText(body, { assetFor });
const counts = content.reduce((acc, b) => ((acc[b._type] = (acc[b._type] ?? 0) + 1), acc), {});
console.log(`Portable Text 块: ${JSON.stringify(counts)}`);

if (DRY) {
  console.log(JSON.stringify(content.slice(0, 4), null, 1).slice(0, 1200));
  process.exit(0);
}

// 2) 建或更新草稿
const payload = {
  slug: option("--slug", "dsh-workload-report"),
  data: {
    title,
    content,
    excerpt: option("--excerpt", "用 AI 干活说不清花在哪？这个 DSH 插件把「我的付出」与 Token 消耗按日期和工作区摊开，含日历热力图、时刻分析、工作区占比，并能一键导出一份可以直接发给客户的自包含 HTML 报告。"),
    meta_title: title,
    meta_description: option("--meta-description", "DeepSeek Harness 工作量报告插件：按日期与工作区看清投入与 Token 消耗，支持导出自包含 HTML 报告。"),
  },
};

let item;
if (POST_ID) {
  const response = await api(`/content/posts/${POST_ID}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: payload.data }) });
  const json = await response.json();
  if (!response.ok) throw new Error(`更新失败: ${JSON.stringify(json).slice(0, 300)}`);
  item = json.data?.item ?? json.data;
  console.log(`已更新草稿 ${item.id}`);
} else {
  const response = await api("/content/posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const json = await response.json();
  if (!response.ok) throw new Error(`创建失败: ${JSON.stringify(json).slice(0, 300)}`);
  item = json.data?.item ?? json.data;
  console.log(`已创建草稿 ${item.id}（slug=${item.slug}）`);
}

// 3) 设置特色图（用第一张正文图片）
const firstAsset = [...cache.values()][0];
if (firstAsset) {
  const response = await api(`/content/posts/${item.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { featured_image: firstAsset } }) });
  console.log("特色图:", response.ok ? "已设置" : `失败 ${response.status}`);
}

// 4) 发布
if (!flag("--no-publish")) {
  const response = await api(`/content/posts/${item.id}/publish`, { method: "POST" });
  const json = await response.json().catch(() => ({}));
  console.log(response.ok ? `已发布 → ${SITE}/posts/${item.slug}` : `发布失败 ${response.status}: ${JSON.stringify(json).slice(0, 200)}`);
}
