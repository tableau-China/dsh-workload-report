# TimeMirror for DSH · Workload Report

> **See your effort and your token spend on the same picture** — by **date** and by **workspace**: a calendar heatmap, time-of-day analysis, workspace share, model usage, and a **one-click self-contained HTML report** you can send straight to a client.
> A DeepSeek Harness (DSH) plugin. Current version: **0.6.6**.

> TimeMirror is a macOS time-distribution app I published on the Mac App Store; this plugin brings the same idea to AI-assisted work. The package/repo keeps the descriptive name `dsh-workload-report` so it can be found in the DSH ecosystem; the brand stays TimeMirror.

[![npm](https://img.shields.io/npm/v/dsh-workload-report?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-workload-report)
[![license](https://img.shields.io/github/license/tableau-China/dsh-workload-report?style=flat-square)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/tableau-China/dsh-workload-report/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tableau-China/dsh-workload-report/actions)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js)](https://nodejs.org)

[中文](./README.zh-CN.md) · English

## What it is

DSH shows stats for the **current session**. This plugin adds the cross-session, cross-project, cross-time view: which dates and which workspaces your effort went to, which hours you were productive, which models consumed the tokens, and what it cost — plus a static report for clients, teammates or monthly reviews.

**Not only cost, but the work behind it.** Active time, active days and turns show what you actually did; tokens and estimated cost show what it consumed. Numbers use the same definitions everywhere, so the dashboard and the exported report agree.

## Install & entry point

```bash
# npm (published package)
dsh plugin add dsh-workload-report

# or straight from GitHub
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main

# or link a local checkout
dsh plugin --profile web add link:$PWD
```

Restart the Web profile after installing. The entry appears at the **bottom of the sidebar**: **Workload report** (**工作量报告** in Chinese). The built client bundle (`lib/client.js`) is committed, so installing from GitHub/npm needs no local build.

Uninstall: `dsh plugin --profile web remove dsh-workload-report`.

## Data sources & principles

- **Official interfaces only.** Session identity comes from `sessionQuery.listSessions()`; statistics come from the official projections (`sessionProjections`, `sessionProjectionCache`) and, when needed, the official `sessionQuery.observeSession()` cold read. Model and hourly-token dimensions use the official `sessionQuery.readSession()` event log.
- **No storage-format parsing.** The plugin never opens `*.jsonl.zstd`, never parses zstd/JSONL, and never reads the harness's internal projection-cache files. Formats can change between releases; the official seams are the contract.
- **Zero outbound requests by default.** All statistics stay on your machine. The plugin exposes read-only HTTP routes only, and writes only its own local index at `<DSH_HOME>/workload-report/index-v7.json` plus, when the AI profile is enabled, its profile cache in the same directory (both safe to delete; they rebuild).
- **Two opt-in exceptions** are the optional balance chip (`balance.enabled: true`, off by default), where the **host** calls the official `deepseekAccount` service, and the optional **AI user profile** (`aiProfile.enabled: true`, off by default), which calls the configured model provider with aggregate statistics only. See [Privacy](#privacy).
- **No invented numbers.** Unreadable legacy sessions are excluded and counted in the UI; models without an official price show **—** instead of a made-up cost.

## Features (0.6.6)

- **Eight KPIs**: cumulative active time (**net active**, waiting shown on a second line), total tokens (full integer you can verify), model cost, active days, conversations, turns / steps, cache-read share, and the most active model.
- **Daily usage trend**: calendar heatmap (Mon–Sun × Year-Week, colour and bar height = active time) or a bar chart; weekends use a different colour, the peak bar is always labelled, and every calendar cell, bar, weekday total and axis label has its own tooltip.
- **Time of day**: bars default to **token output** (switchable to **turns**); the dots above the bars show **human-message density**. Peak bars are highlighted and labelled; the legend sits on one row.
- **Workspace share**: Top 6 + others donut, switchable between **time** and **tokens**.
- **Model token share**: a compact donut on the dashboard; full model details live in the next tab.
- **Model usage tab**: treemap (area = token share, Top 8 + others), stacked daily trend (Top 6 models), a detail table (share / requests / input / output / cache read / cache-hit rate / estimated cost), metric chips (Token / requests / model time), click-to-filter, and official pricing links. Costs are estimated only for models with official public prices.
- **Top sessions and daily detail**: ratio bars in the main numeric columns (sessions: turns / steps / active / output; daily detail: conversations / turns / active / tokens) and sortable headers on the sessions table; the daily detail table covers the last 31 days.
- **Export a self-contained HTML report**: one file with inline CSS and inline SVG, **no scripts and no external assets**; light/dark themes, custom title/note, optional `anonymize=1` to hide workspace names and session titles. The report mirrors the dashboard: 8 KPIs, calendar + bars, hourly density dots + turns mini-chart, ratio bars, and the same definitions. Only official pricing pages are linked.
- **Theme and locale aware**: all colours use host theme tokens (`--dsw-*`), so the dashboard follows the harness light/dark theme; all UI strings are aligned between Chinese and English.
- **AI user profile (optional, off by default)**: a card on the by-date tab that generates a 3–5 trait profile + 1 suggestion from **aggregate statistics only** — never conversations, titles, or paths. The same statistics fingerprint reuses the disk cache; any failure falls back to deterministic local rules. See [AI user profile](#ai-user-profile).

## Screenshots

**By date**: eight KPIs + calendar heatmap + time-of-day analysis with human-message density dots + workspace share

![dashboard by date](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png)

**By workspace**: effort on the left, token spend on the right, both bars share one scale

![dashboard by workspace](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-workspace.png)

**The exported report**: one self-contained file, safe to send to a client

![report light](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/report-light.png)

<details>
<summary>Dark-theme report</summary>

![report dark](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/report-dark.png)

</details>

## Metric definitions

The full definitions live in **[docs/metrics.md](./docs/metrics.md)**. Durations use one language-neutral `H / M / S` format (like K/M/B for tokens). The points users misread most:

### Active time

- **Active time = model time + tool time − waiting for user.** It is **cumulative engine work**, not wall-clock time; concurrent sessions and subagents each add up. It is not the elapsed time you sat in front of the screen.
- **Waiting for user** is split out as `waitMs` and excluded from active time. The same value is persisted with the index. The official `totals.activeMs` is kept for cross-checking: `netActiveMs + waitMs === activeMs` (±1 ms).
- **Three-layer wait rule** (a tool interval is treated as waiting only when it lasts at least `waitMinMs` **and** meets either condition):
  1. the tool name is in `waitTools` (default `ask_user_question`, `exit_plan_mode`);
  2. a `user/message` arrives between `tool/call` and `tool/result` (any tool).
- **Long-task exemption**: a long build/test tool that is not a wait tool and has no interleaved user message still counts as work. Short interactions below `waitMinMs` are not removed, to avoid fragmenting real work.
- Set `excludeWait: false` to disable the whole rule (behaviour matches 0.6.0).

### Time of day

The dashboard card has **two measures** and a third visual layer:

- **Tokens (default)**: each `assistant/message` usage is bucketed by the **message time** into the selected time zone. The sum of the 24 hour buckets equals the session's official token total (integer rescaling when the event total differs).
- **Turns**: the number of sessions that **started** in that hour (net active time is still bucketed by turn start for the rest of the dashboard).
- **Human-message dots** on top: `user/message` count per hour; dot radius encodes relative density.
- Sessions whose event logs cannot be read (very old v0 logs, not backfilled, or `modelUsage: off`) do **not** get a fabricated hourly distribution. They are excluded from the token chart and the card says **“Token 未计入 N 个会话”**; their totals are still included in the KPI totals.

### Tokens, conversations, dates

- **Total tokens** = uncached input + output + cache read + cache write. Cache reads usually dominate and cost the least; do not price them as fresh input.
- **Conversations** = sessions with at least one step. Zero-step sessions (opened but unused) are listed separately and excluded from this KPI.
- **Attribution date** = the session's creation day in the selected time zone. A session resumed across midnight still belongs to its creation day.
- **Model cost** is estimated from built-in official public prices (DeepSeek peak/off-peak, as-of 2026-10-13). Only models with an official price get a number; models without one show **—**. Estimates never fetch prices at runtime. The estimate is intentionally not described as an invoice.

## Configuration

Override any of these in the profile's `cordis.patch.yml` (all optional):

```yaml
- id: workload-report
  name: dsh-workload-report
  config:
    defaultDays: 7                 # initial range: 7 | 30 | 90 | all
    refreshMs: 30000               # index refresh interval (ms)
    snapshotCacheMs: 15000         # snapshot cache per query (invalidated by events/index/fold)
    modelFoldWarmupMs: 2000        # warm-up fold after the index is ready (never from opening the panel)
    modelFoldIntervalMs: 720000    # periodic fold maintenance (12 min)
    modelFoldIdleMs: 600000        # only refold a live session after 10 min without events
    modelRetryMs: 1800000          # retry failed rows after 30 min (never changes the status line)
    defaultScope: all              # all | main | subagent
    modelUsage: auto               # auto | off (off = do not read event logs for model/hourly data)
    excludeWait: true              # false = keep 0.6.0 behaviour (no wait detection)
    waitTools:                     # tools treated as waiting for a human
      - ask_user_question
      - exit_plan_mode
    waitMinMs: 60000               # minimum interval to be treated as waiting (ms)
    activeModelMetric: requests    # requests | tokens | activeMs
    workspaceAliases:              # display names, useful in client reports
      my-shop-app: Retail Order System
    balance:                       # optional balance chip — OFF by default
      enabled: false               # true = host calls platform.deepseek.com (see Privacy)
      refreshMs: 300000            # balance cache TTL (ms)
    aiProfile:                     # optional AI user profile — OFF by default
      enabled: false               # true = on-demand model call with aggregate stats only
      provider: ""                 # empty = host agentDefaultModel selection
      model: ""                    # use together with provider
      maxTokens: 900
      timeoutMs: 60000             # AbortSignal.timeout(timeoutMs)
      cacheTtlMs: 86400000         # fingerprint cache TTL (ms); 0 = no disk cache
```

The default model prices are built in and offline; `pricing.overrides`, `pricing.asOf` and `pricing.links` let you replace them if your contract differs. See [docs/models.md](./docs/models.md).

## AI user profile

**Off by default and generated on demand.** Enable it only if you want a short “how you work” card next to your stats:

- **Trigger**: opening the panel only runs a `probe` (no model call). The model is called when you click **Generate profile / Regenerate**; the button is disabled while generating.
- **What is sent**: a strict whitelist of aggregate statistics — range, net active time, wait time, conversations, turns, steps, total tokens, cache-hit rate, 24 hourly token buckets, top 5 workspaces by name + share, top 5 models by name + share, weekend share, and night share (22:00–06:00). **Never** conversation content, session titles, cwd, paths, session ids, or event logs. The host asserts the payload key set is exactly the whitelist.
- **Cache**: SHA-256 (first 16 hex chars) of the stable JSON of that whitelist. The result is cached on disk next to the index (atomic `tmp` → `rename`); an identical fingerprint returns the cache without another model call. `force=1` regenerates.
- **Failure = local rules**: missing `llm` service, not signed in / no models, timeout, non-`stop` finish, empty output, or unparsable JSON all fall back to a deterministic **local rules** profile (3–5 traits + 1 suggestion, no network). The response always carries `source: "llm" | "local"` and a stable `code`; nothing is thrown to the UI.
- **Not counted in this report**: the profile call is an auxiliary call outside any session, so it is **not** included in this plugin's token / cost report. The card shows that call's input/output tokens and generation time separately.
- **Not in the HTML report**: the static export intentionally omits the profile (see `docs/report-parity.md`); an AI judgment about a person does not belong in a file sent to a client or printed.

Full details: [docs/ai-profile.md](./docs/ai-profile.md).

## Read-only API

| Route | Description |
| --- | --- |
| `GET {apiPath}/snapshot?days=30&tz=Asia/Shanghai&scope=all` | Aggregated snapshot JSON (totals / byDay / byWorkspace / byHour / bySession / calendar / byModel / modelDaily / diagnostics) |
| `GET {apiPath}/export.json?...` | Same payload with a `content-disposition` header |
| `GET {apiPath}/report.html?days=90&theme=dark&anonymize=1&title=...` | Self-contained HTML report |
| `GET {apiPath}/profile?days=30&tz=...&lang=zh&probe=1` | AI user profile: `probe=1` only reports enabled/signed-in; otherwise generates on demand; `force=1` bypasses the fingerprint cache |
| `GET {apiPath}/health` | Index diagnostics (sessions, checkpoint hits, cold reads, read failures, duration) |
| `GET {apiPath}/balance` | Cached balance state for the toolbar chip; never touches the index |

Parameters: `from`/`to` (YYYY-MM-DD, take precedence over `days`), `days`, `all=1` (earliest active day → today), `tz` (IANA time zone), `scope`.

## Index & upgrading

- Index file: `<DSH_HOME>/workload-report/index-v7.json`; `INDEX_VERSION = 7`.
- Upgrading from 0.6.5 or earlier **rebuilds the index and re-folds event data on first launch** (the hour buckets and hourly token/human-message fields are versioned). The API returns progressively filled data with `indexing: true` while this runs.
- Deleting the index is safe: the plugin cold-reads historical sessions again. Cold reads use official interfaces and concurrency 8 (about 2 minutes for 300+ sessions on the author's machine).
- Very early **v0-format sessions** may not be readable at all. They are excluded from statistics and the UI reports how many; the time-of-day card shows **“Token 未计入 N 个会话”** when their token distribution cannot be read.

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/metrics.md](./docs/metrics.md) | Definitions: active/net/wait, time-of-day, tokens, calendar, workspaces |
| [docs/models.md](./docs/models.md) | Model attribution, grouping, cache-hit rate, peak/off-peak pricing and cost estimation |
| [docs/ui-conventions.md](./docs/ui-conventions.md) | Shared UI components, card heads, legend/status rules, tooltip rules |
| [docs/report-parity.md](./docs/report-parity.md) | Dashboard → report parity checklist, intentional differences, structural assertions |
| [docs/ai-profile.md](./docs/ai-profile.md) | AI user profile: whitelist payload, cache fingerprint, fallback codes, privacy |
| [CHANGELOG.md](./CHANGELOG.md) | Version history and testing notes |
| [PROGRESS.md](./PROGRESS.md) | Decisions, measurements, environment gotchas and release notes |

## Privacy

All statistics stay on your machine. The plugin registers **read-only** HTTP routes only: by default no outbound requests, no telemetry, no user content collected. It writes only its own index cache plus the optional AI-profile cache; nothing else in your harness data is touched. The exported report may contain session titles unless you pass `anonymize=1`.

**Optional balance chip — off by default.** Only when you set `balance.enabled: true` does the host call the official `deepseekAccount` service: `getBalance()` makes the **host** request `https://platform.deepseek.com/api/v0/users/get_user_summary` (the account balance endpoint). It is opt-in and cached for `balance.refreshMs`. The top-up/usage links come from the service's local `getState()` and need no network. A failed or timed-out query shows an em dash with a top-up link — never an error dialog. The balance is rendered only in your own toolbar chip and is **never written into the exported HTML report**.

**Optional AI user profile — off by default.** Only when you set `aiProfile.enabled: true` and click **Generate profile** does the plugin call the `llm` service (and your configured model provider) with the aggregate whitelist described in [AI user profile](#ai-user-profile). No conversation text, titles, paths, session ids, or event logs are sent. The response is cached on disk in the plugin's own directory; the static HTML report never contains it. If the service is missing, you are not signed in, the call times out, or parsing fails, the card falls back to local rules and shows the reason — no error dialog.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm add -D esbuild puppeteer-core` | Install build and browser-test dependencies (or point `ESBUILD_PATH` / `WL_PUPPETEER_DIR` at existing installs) |
| `node build.mjs` | Bundle `src/client/` into `lib/client.js` (ModuleLoader factory format) with esbuild |
| `node test/verify.mjs` | **595 offline assertions**: aggregation semantics, time zones, turn-based hour bucketing and conservation, hourly tokens by message time, human-message density, wait exclusion (all three rules + long-task exemption + `excludeWait:false` regression), index/read fallbacks, report structure parity, i18n key alignment, and balance states |
| `./test/e2e-boot.sh 3299` | Boot an **isolated instance** (own DSH_HOME and port) without touching your running GUI |
| `node test/e2e-ui.mjs` | Real-browser E2E: calendar/bar switching, geometry, donuts, report export, time-of-day card |

CI runs `build.mjs` + `verify.mjs`, and fails if the committed `lib/client.js` differs from a fresh build.

## Compatibility

- DSH `0.2.x`, **including `alpha` prereleases** (developed and verified against `@deepseek-ai/dsh@0.2.1-alpha.2`). The plugin depends only on official interfaces (`sessionProjections` / `sessionProjectionCache` / `sessionQuery`) and Node built-ins, never on internal file formats.
- The first launch cold-reads historical sessions whose projection checkpoints are missing; the API returns progressively filled data with `indexing: true`, and restarts reuse the persisted index.
- Very early **v0-format sessions** may not be migratable/readable by the current harness. They are excluded from statistics and the UI reports how many.

## Author

**[XILEJUN](https://github.com/tableau-China)** — author of TimeMirror · [Blog post (中文)](https://github.com/tableau-China/dsh-workload-report/blob/main/docs/blog.md)

## License

[MIT](./LICENSE)
