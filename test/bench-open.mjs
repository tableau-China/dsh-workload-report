// 打开耗时基准（隔离 stub 宿主，不依赖真实 DSH 实例）。
// 用法：node test/bench-open.mjs [--json=path] [--label=before]
//
// 场景：
//   cold    冷缓存首开：索引就绪后第一次 /snapshot（无聚合缓存）
//   warm    热缓存再开：TTL 内连续 5 次 /snapshot
//   pending 回填中打开：模型折叠正在读事件日志时连续 5 次 /snapshot
//   trigger 打开 5 次是否触发读日志（新增 1 个会话，refreshMs=0 → 每次打开都会重扫）
import { performance } from "node:perf_hooks";
import { rm } from "node:fs/promises";
import { apply } from "../index.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const LABEL = arg("label", "run");
const JSON_PATH = arg("json", "");
const SESSIONS = Number(arg("sessions", "500"));
const HOUR = 3600000;
const base = Date.parse("2026-10-10T02:00:00Z");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const records = Array.from({ length: SESSIONS }, (_, index) => {
  const id = `session-${index}`;
  const header = { id, createdAt: base - index * HOUR, cwd: `/Users/me/proj-${index % 12}`, isSeeded: false, version: 4, title: `会话 ${index}` };
  return { header, live: false, persisted: true };
});
const snapshotOf = (index) => ({
  asOfSeq: 10 + index,
  values: {
    sessionStats: { turns: 2 + (index % 3), steps: 4 + (index % 5), llmMs: HOUR, toolMs: 30 * 60000 },
    tokenUsage: { totals: { uncachedInputTokens: 100 + index, outputTokens: 50 + index, cacheReadTokens: 400 + index, cacheWriteTokens: 0 } },
    title: `会话 ${index}`,
  },
});
const checkpoints = new Map(records.filter((_, index) => index % 3 !== 0).map((record) => [record.header.id, snapshotOf(records.indexOf(record))]));

function makeCtx({ readDelayMs = 2, coldDelayMs = 0 }) {
  const state = { reads: 0, cold: 0 };
  const routes = [];
  const events = [
    { type: "assistant/message", seq: 1, time: base, data: { turn: 1, step: 1, message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 }, stream: [{ type: "chunk", time: base }, { type: "chunk", time: base + 500 }] } },
  ];
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {}; },
    on() { return () => {}; },
    sessions: { get: () => undefined },
    sessionProjections: { snapshot: () => undefined },
    sessionQuery: {
      listSessions: async () => records,
      observeSession: async (id) => {
        state.cold += 1;
        if (coldDelayMs > 0) await sleep(coldDelayMs);
        const record = records.find((item) => item.header.id === id);
        return { header: record?.header ?? { id }, projections: { asOfSeq: 77, values: { sessionStats: { turns: 1, steps: 1, llmMs: HOUR, toolMs: 0 }, tokenUsage: { uncachedInputTokens: 5, outputTokens: 7, cacheReadTokens: 9, cacheWriteTokens: 0 } } }, dispose() {} };
      },
      readSession: async (id) => {
        state.reads += 1;
        if (readDelayMs > 0) await sleep(readDelayMs);
        return { session: records.find((item) => item.header.id === id)?.header ?? { id }, inheritedEventCount: 0, events };
      },
    },
    sessionProjectionCache: { cachedSnapshot: (header) => checkpoints.get(String(header.id)) },
    webServer: { register(spec) { routes.push(spec); return () => {}; } },
  };
  return { ctx, routes, state };
}

function callOn(routes, url) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0, headers: {}, body: "",
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(chunk) { if (chunk) this.body += chunk; resolve({ status: this.statusCode, headers: this.headers, body: this.body }); },
    };
    try { routes[0].handler({ method: "GET", url }, res); } catch (error) { reject(error); }
  });
}
async function health(routes) { return JSON.parse((await callOn(routes, "/workload-report/v1/health")).body); }
async function waitFor(routes, predicate, label, timeoutMs = 15000) {
  const started = performance.now();
  let last = null;
  while (performance.now() - started < timeoutMs) {
    const body = await health(routes);
    last = body;
    if (predicate(body)) return body;
    await sleep(10);
  }
  throw new Error(`等待超时：${label}：${JSON.stringify(last?.diagnostics?.modelFold)} sessions=${last?.diagnostics?.sessions} scheduled=${last?.diagnostics?.foldScheduled} skipped=${last?.diagnostics?.foldSkipped}`);
}
async function timedSnapshot(routes) {
  const started = performance.now();
  const response = await callOn(routes, "/workload-report/v1/snapshot?days=60&tz=UTC");
  return { ms: performance.now() - started, body: JSON.parse(response.body) };
}
async function instantiate(tag, config = {}) {
  const { ctx, routes, state } = makeCtx(config.readDelayMs === undefined ? {} : { readDelayMs: config.readDelayMs });
  const indexPath = `/tmp/wl-bench-${process.pid}-${tag}.json`;
  await rm(indexPath, { force: true });
  const returned = apply(ctx, { indexPath, refreshMs: 30000, ...config });
  return { routes, state, indexPath, returned };
}
async function waitReady(instance) {
  return waitFor(instance.routes, (body) => body.indexing === false && body.diagnostics?.lastSyncAt > 0, "索引就绪");
}
async function waitFoldDone(instance) {
  return waitFor(instance.routes, (body) => body.diagnostics?.sessions >= SESSIONS && body.diagnostics?.modelFold?.running === false && body.diagnostics.modelFold.pending === 0, "索引与折叠完成");
}

const result = { label: LABEL, sessions: SESSIONS, at: new Date().toISOString(), scenarios: {}, cache: {}, fold: {} };

// 冷缓存首开 / 热缓存再开（这里等折叠完成，避免把后台折叠算进打开耗时）
{
  const instance = await instantiate("open", { modelFoldWarmupMs: 20 });
  const readyAt = performance.now();
  await waitReady(instance);
  result.indexReadyMs = performance.now() - readyAt;
  await waitFoldDone(instance);
  const cold = await timedSnapshot(instance.routes);
  result.scenarios.cold = { ms: cold.ms, sessions: cold.body.totals?.sessions ?? 0, snapshotMs: cold.body.diagnostics?.snapshotMs ?? null };
  const warmRuns = [];
  for (let i = 0; i < 5; i += 1) warmRuns.push((await timedSnapshot(instance.routes)).ms);
  result.scenarios.warm = { ms: warmRuns.reduce((sum, value) => sum + value, 0) / warmRuns.length, runs: warmRuns };
  const after = (await health(instance.routes)).diagnostics ?? {};
  result.cache = {
    hits: after.snapshotCacheHits ?? after.snapshotCache?.hits ?? null,
    misses: after.snapshotCacheMisses ?? after.snapshotCache?.misses ?? null,
    hitRate: after.snapshotCache?.hitRate ?? null,
    ttlMs: after.snapshotCache?.ttlMs ?? null,
  };
  await rm(instance.indexPath, { force: true });
}

// 回填中打开（折叠正在读事件日志）
{
  const instance = await instantiate("pending", { modelFoldWarmupMs: 20, readDelayMs: 4 });
  await waitReady(instance);
  await waitFor(instance.routes, (body) => body.diagnostics?.modelFold?.running === true, "折叠开始", 8000);
  const runs = [];
  for (let i = 0; i < 5; i += 1) runs.push((await timedSnapshot(instance.routes)).ms);
  const state = (await health(instance.routes)).diagnostics?.modelFold ?? {};
  result.scenarios.pending = { ms: runs.reduce((sum, value) => sum + value, 0) / runs.length, runs, running: state.running === true, pending: state.pending ?? null, phase: state.phase ?? null };
  await rm(instance.indexPath, { force: true });
}

// 打开 5 次是否触发读日志：索引就绪后新增一个从未折过的会话，refreshMs=0 → 每次打开都会重扫
{
  const instance = await instantiate("trigger", { modelFoldWarmupMs: 60000, refreshMs: 0 });
  await waitReady(instance);
  // 旧版会在 sync 末尾自动折叠；新版只等后台定时器（预热 60s 未到 → 不折）。
  // 给旧版 50ms 启动窗口并等它跑完，两边都以「稳定后」为基线。
  await sleep(50);
  await waitFor(instance.routes, (body) => body.diagnostics?.modelFold?.running === false, "折叠空闲", 5000);
  const newHeader = { id: `session-new-${process.pid}`, createdAt: base + HOUR, cwd: "/Users/me/proj-new", isSeeded: false, version: 4, title: "新会话" };
  records.push({ header: newHeader, live: false, persisted: true });
  checkpoints.set(newHeader.id, { asOfSeq: 5, values: { sessionStats: { turns: 1, steps: 1, llmMs: HOUR, toolMs: 0 }, tokenUsage: { totals: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 } } } });
  const before = instance.state.reads;
  for (let i = 0; i < 5; i += 1) await timedSnapshot(instance.routes);
  await sleep(120);
  const afterOpen = instance.state.reads;
  await sleep(300);
  const afterSettle = instance.state.reads;
  result.fold = { readsBeforeOpen: before, readsAfterOpen: afterOpen, readsAfterSettle: afterSettle, triggeredByOpen: afterOpen - before };
  await rm(instance.indexPath, { force: true });
}

const output = JSON.stringify(result, null, 2);
console.log(output);
if (JSON_PATH !== "") {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(JSON_PATH, output + "\n");
}
process.exit(0);
