# TimeMirror for DSH · Workload Report

> Put **your effort** and **your token spend** on the same picture: see where your time went and where the tokens went, by **date** and by **workspace** — calendar heatmap, time-of-day analysis, workspace share, and a **one-click self-contained HTML report you can send straight to a client**.
> A DeepSeek Harness (DSH) plugin for effort & token insights.

> **TimeMirror** is a macOS time-distribution app I published on the Mac App Store; this plugin brings the same idea to AI-assisted work — **the time you and your AI spend, and what it costs, made visible**.
> The package/repo uses the descriptive name `dsh-workload-report` so it can be found in the DSH ecosystem; the brand stays TimeMirror.

[![npm](https://img.shields.io/npm/v/dsh-workload-report?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-workload-report)
[![license](https://img.shields.io/github/license/tableau-China/dsh-workload-report?style=flat-square)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/tableau-China/dsh-workload-report/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tableau-China/dsh-workload-report/actions)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js)](https://nodejs.org)

[中文](./README.zh-CN.md) · English

## What problem it solves

You use AI every day, but you **cannot say where the work went or what it was worth**:

- **Self-review**: which project did the last 30 days actually go to? Which hours am I sharpest?
- **Reporting to a client or your team**: not "I've been busy", but "this project took 46.2% of my effort, 3.74 B tokens, and I was on it 18 of the last 30 days."
- **Blog posts / monthly reports**: a calendar heatmap plus time-of-day analysis is made to be screenshotted.

DSH itself only shows a stats line for the **current session**; the cross-session, cross-project, cross-time view is what this plugin adds.

**Not just cost — the work behind it.** Cost meters tell you what you spent; this plugin also tells you *what you did*: how many days you showed up, which hours you were sharpest, and which project your effort actually went into. That is the part you can put in front of a client.

## Features

- ✅ **Effort vs. spend per workspace**: each row shows "My effort" on the left (active time + active days + turns/steps) and "Token spend" on the right (total + output/cache). Both bars use the same scale, so they compare directly.
- ✅ **Calendar heatmap**: rows Mon–Sun, columns Year-Week, colour = active time. It always shows the **full history**, with 7 per-weekday totals glued to the right edge — you can see at a glance which weekday you are busiest.
- ✅ **Time-of-day analysis**: who is active from 0–23, with the peak hour highlighted (definition: bucketed by real event timestamps — model `request/header → assistant/message`, tool `tool/call → tool/result` — strictly conserving total active time; sessions not yet backfilled fall back to wall-clock share).
- ✅ **Workspace donut**: Top 6 + others, switchable between time and tokens.
- ✅ **Shareable HTML report**: a single file with inline CSS and inline SVG, no scripts and no external links; light/dark themes, custom title and note, and `anonymize=1` to hide workspace names and session titles.
- ✅ **Six KPIs**: active time / total tokens (as a full integer you can verify) / active days / conversations / turns·steps / cache-read share.
- ✅ **Official interfaces only**: no log-format parsing, no business data written, **no outbound requests by default**. Values come from zero-I/O projection-checkpoint reads, with an official cold-read fallback and a reusable local index. The one opt-in exception is the optional balance chip (off by default) — see Privacy.
- ✅ **Theme and locale aware**: every colour comes from host theme tokens (`--dsw-*`), so it follows the harness's light/dark theme and Chinese/English locale.

## Screenshots

**Home**: six KPIs + calendar heatmap (switchable to a bar chart) + side-by-side time-of-day analysis and workspace share + a collapsed daily table

![dashboard](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png)

**By workspace**: effort on the left, token spend on the right, two bars on one scale

![workspace](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-workspace.png)

**The exported report** (single file, safe to send to a client)

![report light](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/report-light.png)

<details>
<summary>Dark-theme report</summary>

![report dark](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/report-dark.png)

</details>

## Install

### 1. Straight from GitHub (recommended)

```bash
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main
```

The built client bundle (`lib/client.js`) is committed, so **no local build is needed**. Restart the Web profile afterwards — a "Workload report" entry appears at the bottom of the sidebar.

### 2. Link a local checkout

```bash
cd /path/to/dsh-workload-report
dsh plugin --profile web add link:$PWD     # points the profile at your source tree
```

### 3. From npm

```bash
dsh plugin --profile web add dsh-workload-report
```

> Published on npm: <https://www.npmjs.com/package/dsh-workload-report>
> If your npm client points at a mirror (e.g. npmmirror), a brand-new package can take a few minutes to appear — use option 1 if you are in a hurry.

Uninstall: `dsh plugin --profile web remove dsh-workload-report`.

## Configuration

Override any of these in your profile's `cordis.patch.yml` (all optional):

```yaml
- id: workload-report
  name: dsh-workload-report
  config:
    apiPath: /workload-report/v1        # read-only API prefix
    defaultDays: 7                      # default range
    defaultScope: all                   # all | main | subagent
    defaultTitle: Workload Report       # report title
    workspaceAliases:                   # display names (very handy for client-facing reports)
      my-shop-app: Retail Order System
      data-platform: Data Platform
    balance:                            # optional balance chip — OFF by default
      enabled: false                    # true = host calls platform.deepseek.com (see Privacy)
      refreshMs: 300000                 # cache TTL for the balance query (ms)
```

## Read-only API

| Route | Description |
| --- | --- |
| `GET {apiPath}/snapshot?days=30&tz=Asia/Shanghai&scope=all` | Aggregated snapshot JSON (totals / byDay / byWorkspace / byHour / bySession / calendar / diagnostics) |
| `GET {apiPath}/export.json?...` | Same payload, sent with `content-disposition` for download |
| `GET {apiPath}/report.html?days=90&theme=dark&anonymize=1&title=...` | Self-contained HTML report |
| `GET {apiPath}/health` | Index diagnostics (session count, checkpoint hits, cold reads, read failures, duration) |
| `GET {apiPath}/balance` | Cached balance state for the toolbar chip (enabled / supported / loggedIn / amount / bonus / top-up & usage links); never touches the index |

Parameters: `from`/`to` (YYYY-MM-DD, take precedence over `days`), `days`, `all=1` (earliest active day → today), `tz` (IANA time zone), `scope`.

## Metric definitions

The full definitions live in **[docs/metrics.md](./docs/metrics.md)**. Durations are always shown in **`H / M / S`** (language-neutral, like K/M/B for tokens, so one format serves every locale). The three most misunderstood:

- **Active time** = model time + tool time − waiting for user. It is **cumulative engine work**, not wall-clock time; concurrent sessions and subagents each add up. Waiting (interaction tools such as `ask_user_question`, or any tool whose call→result span contains a `user/message`, ≥ 60s) is excluded from active time and reported separately as `waitMs`; the official `totals.activeMs` is kept for cross-checking (`netActiveMs + waitMs === activeMs`).
- **Conversations** = sessions with at least one step. Zero-step sessions (opened but unused) are listed separately.
- **Attribution date** = the session's creation day in the selected time zone; a session resumed across midnight still counts on its creation day.

## Privacy

All statistics stay on your machine. The plugin registers **read-only** HTTP routes only: by default no outbound requests, no telemetry, no user content collected.
The single file it writes is its own index cache at `<DSH_HOME>/workload-report/index-v*.json` — delete it and the plugin rebuilds by cold-reading; nothing else in your harness data is touched.
Whether the exported HTML report contains session titles is your call (`anonymize=1` hides them).

**Optional balance chip — off by default.** Only when you set `balance.enabled: true` does the host call the official `deepseekAccount` service: `getBalance()` makes the **host** request `https://platform.deepseek.com/api/v0/users/get_user_summary` (the account balance endpoint). That is the only outbound request this plugin can ever trigger, it is opt-in, and it is cached for `balance.refreshMs`. The top-up/usage links come from the service's local `getState()` and need no network. A failed or timed-out query is shown as an em dash with a top-up link — never as an error dialog. The balance is rendered only in your own toolbar chip; it is **never** written into the exported HTML report.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm add -D esbuild puppeteer-core` | Install build and E2E dependencies (or point `ESBUILD_PATH` / `WL_PUPPETEER_DIR` at existing installs) |
| `node build.mjs` | Bundle `src/client/` into `lib/client.js` (ModuleLoader factory format) with esbuild |
| `node test/verify.mjs` | 415 offline assertions: aggregation semantics, time zones, turn-based hour bucketing and conservation (multi-turn separation / whole turn attributed to its start hour / cross-time-zone / no flattening on long windows / apportion fallback), waiting-for-user exclusion (interaction whitelist / human-input interleaving / short-interaction threshold / long-task exemption / net-active conservation / `excludeWait:false` 0.6.0 regression), "all-time" start, calendar data source, HTML escaping, both token shapes, cold-read fallback, `inject` declaration check, host routes, and the balance states (off by default / signed in / signed out / failed / service absent) with isomorphic chip text |
| `./test/e2e-boot.sh 3299` | Boot an **isolated instance** (own DSH_HOME and port, copied projection data) without touching your running GUI |
| `node test/e2e-ui.mjs` | 63 real-browser assertions: calendar/bar switching, side-by-side geometry, weekday bars, donut switching, collapsed detail, report export |

CI runs `build.mjs` + `verify.mjs`, and fails if the committed `lib/client.js` differs from a fresh build.

## Compatibility

- DSH `0.2.x`, **including `alpha` prereleases** (developed and verified against `@deepseek-ai/dsh@0.2.1-alpha.2`): the plugin only depends on official interfaces (`sessionProjections` / `sessionProjectionCache` / `sessionQuery`) and Node built-ins, never on internal file formats — so it can follow new releases. **Staying compatible with the latest alpha is one of this project's goals**; breakages will be tracked in issues and the CHANGELOG.
- The first launch cold-reads historical sessions whose projection checkpoints are missing (about 2 minutes for 300+ sessions on my machine, concurrency 8). During that pass the API returns progressively filled data with `indexing: true`; once the index is persisted, restarts reuse it.
- Very early **v0-format sessions** may not be migratable/readable by the current harness. They are excluded from the statistics and the UI reports how many.

## Author

<table>
<tr>
<td width="40" valign="middle"><img src="https://avatars.githubusercontent.com/u/49810568?v=4" width="32" height="32" alt="XILEJUN" style="border-radius:50%"></td>
<td valign="middle">

**[XILEJUN](https://github.com/tableau-China)** — author of TimeMirror · [Blog post (中文)](https://github.com/tableau-China/dsh-workload-report/blob/main/docs/blog.md)

</td>
</tr>
</table>

## License

[MIT](./LICENSE)
