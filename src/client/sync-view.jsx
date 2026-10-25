/**
 * 「设备同步」页签：状态 / 自检 / 手动同步 / 设备清单。
 *
 * 设计约束（见 docs/ui-conventions.md）：
 *   · 切换控件只用 ChipGroup + Chip，卡片头只用 CardHead；
 *   · 颜色只用宿主主题 token，不写死色值；
 *   · 默认关闭（sync.enabled=false）时**整页只渲染一句提示**，不显示空表格与假状态；
 *   · 凭据永不在界面回显，只显示「已读取 / 未找到」这类存在性信息。
 */

import { useCallback, useEffect, useState } from "react";
import { formatInt } from "../format.js";
import { Chip, ChipGroup } from "./chips.jsx";
import { CardHead } from "./card-head.jsx";

/** 宿主半部注册的只读接口前缀（与 index.js 的默认 apiPath 一致）。 */
const API_PATH = "/workload-report/v1";

/** 时间戳 → 本地可读时间；0 表示从未执行。 */
function formatTime(ms, never) {
  if (!ms) return never;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return never;
  }
}

/** 拉 /sync 状态。 */
function useSyncStatus(refreshKey) {
  const [state, setState] = useState({ status: "loading", body: null, error: null });
  useEffect(() => {
    const abort = new AbortController();
    setState((previous) => ({ ...previous, status: previous.body === null ? "loading" : "refreshing" }));
    fetch(`${API_PATH}/sync`, { signal: abort.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((body) => setState({ status: "ready", body, error: null }))
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setState({ status: "error", body: null, error: String(error?.message ?? error) });
      });
    return () => abort.abort();
  }, [refreshKey]);
  return state;
}

/**
 * 设备筛选器 + 「设备同步」入口。
 *
 * 入口位置：设备 chips（全部设备 / 本机 / <设备名>）同一行的**右侧**，
 * 不再放在顶部页签行「AI 用户画像」之后（用户要求，见 CHANGELOG v2.0.0）。
 * 同步关闭 / 只有本机时也保留入口——同步设置就在那一页，用户需要从这里进去开启。
 *
 * @param devices - 宿主的设备清单（[{key,name,local,rows,stale}]）；为 null / 不足 2 台时不渲染 chip。
 * @param value - 已选设备 key 数组；空数组表示全部设备。
 * @param syncOpen - 「设备同步」页是否正在显示。
 * @param onOpenSync - 打开「设备同步」页；缺省时不渲染入口。
 */
export function DeviceFilter({ devices, value, onChange, t, syncOpen = false, onOpenSync = null }) {
  const hasChips = Array.isArray(devices) && devices.length > 1;
  const entry = typeof onOpenSync === "function" ? (
    <button
      type="button"
      className="wl-btn"
      data-kind="primary"
      data-sync-entry="true"
      data-active={syncOpen ? "true" : undefined}
      onClick={onOpenSync}
    >
      {t("tab.deviceSync")}
    </button>
  ) : null;
  if (!hasChips && entry === null) return null;
  const selected = new Set(value ?? []);
  const allActive = selected.size === 0;
  /**
   * 点「本机」= 互斥单选（只看本机）：后端语义里 local 是「包含本机」的开关，
   * 与其它 chip 叠加时不会缩小范围，多选呈现会让用户以为「只看本机却看到全部」。
   * 因此这里做成：点本机 → 只留 local；再点一次 → 回到全部设备。
   */
  const toggleLocal = () => {
    const localOnly = selected.size === 1 && selected.has("local");
    onChange(localOnly ? [] : ["local"]);
  };
  const toggle = (key) => {
    // 远端设备之间仍是多选；从「只看本机」切到某台远端时自动退出本机模式
    const next = new Set(selected);
    next.delete("local");
    if (selected.has(key) && !selected.has("local")) next.delete(key);
    else next.add(key);
    onChange([...next]);
  };
  return (
    <CardHead title={t("devices.title")} hint={hasChips ? t("devices.hint") : null}>
      {hasChips ? (
        <ChipGroup label={t("devices.title")}>
          <Chip active={allActive} onClick={() => onChange([])}>{t("devices.all")}</Chip>
          {devices.map((device) => (
            <Chip
              key={device.key}
              active={!allActive && selected.has(device.key)}
              data-device={device.key}
              data-stale={device.stale === true ? "true" : undefined}
              title={device.stale === true ? t("devices.stale") : undefined}
              onClick={() => (device.local === true ? toggleLocal() : toggle(device.key))}
            >
              {device.local === true ? t("devices.local") : device.name}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}
      {entry}
    </CardHead>
  );
}

/**
 * 「设备同步」页主体（入口在设备筛选行右侧，见上面的 DeviceFilter）。
 * @param onChanged - 推送/拉取成功后回调（让看板重新拉快照）。
 */

/**
 * 凭据表单：只在 DSH 凭据存储可用时渲染。
 *
 * 安全约定：
 *   · 提交后立刻清空输入框，值只存在于 POST 请求体里；
 *   · 已配置的字段**不回填**（placeholder 提示「留空表示保持不变」）；
 *   · 界面只显示「已配置 / 未配置」与来源，从不回显内容。
 */
export function CredentialForm({ t, transport, onSaved }) {
  const [state, setState] = useState({ status: "loading", vault: false, fields: [], error: null });
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_PATH}/sync/credentials`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setState({ status: "ready", vault: body.vault === true, fields: body.fields ?? [], error: null });
    } catch (error) {
      setState({ status: "error", vault: false, fields: [], error: String(error?.message ?? error) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async (deleteMode = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const payload = deleteMode
        ? { delete: true }
        : { values: Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim().length > 0)) };
      if (!deleteMode && Object.keys(payload.values).length === 0) {
        setMessage({ kind: "fail", text: t("cred.placeholderKept") });
        setBusy(false);
        return;
      }
      const response = await fetch(`${API_PATH}/sync/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
      setDraft({}); // 立刻清空输入框，值不再留在界面上
      if (deleteMode) {
        const stillExternal = (body.fields ?? []).filter((field) => field.fallbackSource === "env" || field.fallbackSource === "file");
        const text = stillExternal.length === 0
          ? t("cred.cleared")
          : t("cred.clearedButExternal", { fields: stillExternal.map((field) => field.label).join(", ") });
        setMessage({ kind: stillExternal.length === 0 ? "ok" : "fail", text });
      }
      else if (body.probe?.ok === true) setMessage({ kind: "ok", text: t("cred.savedOk") });
      else setMessage({ kind: "fail", text: t("cred.savedBad", { message: body.probe?.message ?? "?" }) });
      await load();
      if (typeof onSaved === "function") onSaved();
    } catch (error) {
      setMessage({ kind: "fail", text: t("cred.saveFail", { message: String(error?.message ?? error) }) });
    } finally {
      setBusy(false);
    }
  };

  if (transport === "local") return null;
  if (state.status === "loading") return null;
  if (state.status === "error") return <p className="wl-hint" data-kind="sync-error">{t("cred.saveFail", { message: state.error ?? "" })}</p>;
  if (!state.vault) return <p className="wl-hint" data-kind="sync-error">{t("cred.noVault")}</p>;

  return (
    <div className="wl-cred">
      <CardHead title={t("cred.title")} hint={t("cred.hint")} />
      <div className="wl-cred-fields">
        {state.fields.map((field) => {
          const sourceKey = field.source === "vault" ? "cred.fromVault" : field.source === "file" ? "cred.fromFile" : field.source === "env" ? "cred.fromEnv" : null;
          return (
            <label key={field.id} className="wl-cred-field">
              <span className="wl-cred-label">
                {field.label}
                <span data-kind={field.configured ? "ok" : "missing"}>
                  {field.configured ? t("cred.configured") : t("cred.missing")}
                </span>
              </span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-credential={field.id}
                placeholder={field.configured ? t("cred.placeholderKept") : t("cred.placeholderNew", { label: field.label })}
                value={draft[field.id] ?? ""}
                onChange={(event) => setDraft((previous) => ({ ...previous, [field.id]: event.target.value }))}
              />
              {sourceKey === null ? null : <span className="wl-cred-source">{t(sourceKey)}</span>}
            </label>
          );
        })}
      </div>
      <div className="wl-cred-actions">
        <div className="wl-cred-buttons">
          <button type="button" className="wl-btn" data-kind="primary" disabled={busy} onClick={() => void submit(false)}>
            {busy ? t("cred.saving") : t("cred.save")}
          </button>
          <button type="button" className="wl-btn" disabled={busy} onClick={() => void submit(true)}>{t("cred.clear")}</button>
        </div>
        {message === null ? null : <span className="wl-hint" data-kind={`sync-${message.kind}`}>{message.text}</span>}
      </div>
      <p className="wl-note">{t("cred.why")}</p>
    </div>
  );
}


/**
 * 同步设置：存储方式选择 + 各自连接参数。保存走 profile（立即生效），不含任何机密。
 *
 * 设计要点：
 *   · 传输变化时只渲染该传输需要的字段，其余字段保留在配置里（切回来不用重填）；
 *   · 服务地址/分支有平台预设，选了 GitHub 自动填 api.github.com + main；
 *   · 所有校验在宿主侧做（必填、{machineId} 模板、owner/name 格式），这里只展示错误。
 */
export function SyncSettings({ t, onSaved }) {
  const [state, setState] = useState({ status: "loading", view: null, transports: [], presets: {}, cosRegions: [], canSave: false, error: null });
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_PATH}/sync/settings`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setState({ status: "ready", ...body, error: null });
      setForm(body.view);
      setBaseline(body.view);
    } catch (error) {
      setState((previous) => ({ ...previous, status: "error", error: String(error?.message ?? error) }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setField = (path, value) => setForm((previous) => {
    const next = { ...previous };
    const [head, leaf] = path.split(".");
    if (leaf === undefined) next[head] = value;
    else next[head] = { ...next[head], [leaf]: value };
    return next;
  });

  const changeTransport = (id) => {
    setForm((previous) => {
      const next = { ...previous, transport: id };
      const preset = state.presets?.[id];
      if (preset !== undefined) next.github = { ...next.github, ...preset };
      return next;
    });
  };

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      // 只提交**变化过**的字段：未改动的字段保持宿主侧现值，避免把没填的空串写进配置
      const values = {};
      for (const [key, value] of Object.entries(form ?? {})) {
        const before = baseline?.[key];
        if (key === "cos" || key === "github" || key === "local") {
          const changed = {};
          for (const [sub, subValue] of Object.entries(value ?? {})) {
            if (subValue !== before?.[sub]) changed[sub] = subValue;
          }
          if (Object.keys(changed).length > 0) values[key] = changed;
        } else if (value !== before) {
          values[key] = value;
        }
      }
      const response = await fetch(`${API_PATH}/sync/settings`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ values }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
      setMessage({ kind: "ok", text: t("set.saved") });
      setForm(body.view);
      setBaseline(body.view);
      if (typeof onSaved === "function") onSaved();
    } catch (error) {
      setMessage({ kind: "fail", text: t("set.saveFail", { message: String(error?.message ?? error) }) });
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return null;
  if (state.status === "error" || form === null) return null;

  const transport = form.transport;
  const isRepo = transport === "github" || transport === "gitea";
  const helpKey = transport === "cos" ? "set.cosHelp" : transport === "local" ? "set.localHelp" : transport === "gitea" ? "set.giteaHelp" : "set.githubHelp";
  const text = (id, label, hint, value, onChange, placeholder) => (
    <label key={id} className="wl-cred-field">
      <span className="wl-cred-label">{label}{hint === null ? null : <span className="wl-cred-source">{hint}</span>}</span>
      <input type="text" data-setting={id} placeholder={placeholder ?? ""} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
    </label>
  );

  return (
    <div className="wl-cred" data-settings="true">
      <CardHead title={t("set.title")} hint={t("set.hint")}>
        <ChipGroup label={t("set.transport")}>
          {(state.transports ?? []).map((item) => (
            <Chip key={item.id} active={transport === item.id} data-transport={item.id} onClick={() => changeTransport(item.id)}>
              {item.label}
            </Chip>
          ))}
        </ChipGroup>
      </CardHead>

      <div className="wl-cred-fields">
        {transport === "cos" ? (
          <>
            {text("cos.bucket", t("set.bucket"), null, form.cos?.bucket, (v) => setField("cos.bucket", v), state.presets?.cos?.bucket ?? "my-sync-1250000000")}
            <label className="wl-cred-field">
              <span className="wl-cred-label">{t("set.region")}<span className="wl-cred-source">{t("set.regionHint")}</span></span>
              <select data-setting="cos.region" value={form.cos?.region ?? ""} onChange={(event) => setField("cos.region", event.target.value)}>
                <option value="">—</option>
                {(state.cosRegions ?? []).map((region) => <option key={region} value={region}>{region}</option>)}
              </select>
            </label>
          </>
        ) : null}

        {isRepo ? (
          <>
            {text("github.repo", t("set.repo"), null, form.github?.repo, (v) => setField("github.repo", v), "owner/name")}
            {text("github.branch", t("set.branch"), null, form.github?.branch, (v) => setField("github.branch", v), "main")}
            {text("github.baseUrl", t("set.baseUrl"), null, form.github?.baseUrl, (v) => setField("github.baseUrl", v), "https://api.github.com")}
          </>
        ) : null}

        {transport === "local" ? text("local.dir", t("set.dir"), null, form.local?.dir, (v) => setField("local.dir", v), "~/sync/dsh-workload") : null}

        {text("machineName", t("set.machineName"), t("set.machineNameHint"), form.machineName, (v) => setField("machineName", v), "Mac mini")}
        {text("path", t("set.path"), t("set.pathHint"), form.path, (v) => setField("path", v), "machines/{machineId}.json")}
      </div>

      <div className="wl-cred-actions">
        <ChipGroup label={t("set.enabled")}>
          <Chip active={form.enabled === true} onClick={() => setField("enabled", !form.enabled)}>
            {form.enabled === true ? t("set.on") : t("set.off")}
          </Chip>
          <Chip active={form.redactPaths === true} onClick={() => setField("redactPaths", !form.redactPaths)}>{t("set.redact")}</Chip>
        </ChipGroup>
        <ChipGroup label={t("set.save")}>
          <Chip active={false} disabled={busy || state.canSave !== true} onClick={() => void submit()}>
            {busy ? t("set.saving") : t("set.save")}
          </Chip>
        </ChipGroup>
        {message === null ? null : <span className="wl-hint" data-kind={`sync-${message.kind}`}>{message.text}</span>}
      </div>

      {state.canSave === true ? null : <p className="wl-hint" data-kind="sync-error">{t("set.noEditor")}</p>}
      <p className="wl-note"><strong>{t("set.whereToGet")}</strong>：{t(helpKey)}</p>
    </div>
  );
}

export function BySyncView({ t, onChanged }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const state = useSyncStatus(refreshKey);

  /**
   * 「同步设置」保存成功后的联动：刷新本页状态 + 让看板重拉快照。
   * 设置可能改变 enabled / 设备名 / 传输方式，而设备筛选行（设备 chips + 「设备同步」入口就在这一行）
   * 与诊断都来自看板快照——不重拉就要手动点顶部「刷新」才会出现设备 chips。
   */
  const settingsSaved = useCallback(() => {
    setRefreshKey((key) => key + 1);
    if (typeof onChanged === "function") onChanged();
  }, [onChanged]);

  const run = useCallback(async (action) => {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch(`${API_PATH}/sync?action=${action}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const result = body.result ?? body.status ?? {};
      if (action === "probe") {
        setMessage({ kind: result.ok === true ? "ok" : "fail", text: result.ok === true ? t("sync.probeOk") : `${t("sync.probeFail")}（${result.code ?? "?"}）` });
      } else if (action === "push") {
        setMessage(result.ok === true ? { kind: "ok", text: t("sync.pushOk", { n: formatInt(result.rows ?? 0) }) } : { kind: "fail", text: t("sync.failed", { message: result.error ?? "?" }) });
      } else if (action === "pull") {
        setMessage(result.ok === true ? { kind: "ok", text: t("sync.pullOk", { n: formatInt(result.fetched ?? 0) }) } : { kind: "fail", text: t("sync.failed", { message: result.error ?? "?" }) });
      }
      setRefreshKey((key) => key + 1);
      if (action !== "probe" && result.ok === true && typeof onChanged === "function") onChanged();
    } catch (error) {
      setMessage({ kind: "fail", text: t("sync.failed", { message: String(error?.message ?? error) }) });
    } finally {
      setBusy(null);
    }
  }, [t, onChanged]);

  const status = state.body?.status ?? null;
  const enabled = state.body?.enabled === true;

  // 默认关闭：仍然渲染「设置」表单（否则用户没有入口开启它），只是不显示设备表格
  if (state.status === "ready" && !enabled) {
    return (
      <div className="wl-sync" data-enabled="false">
        <SyncSettings t={t} onSaved={settingsSaved} />
        <p className="wl-hint" data-kind="sync-disabled">{t("sync.disabled")}</p>
      </div>
    );
  }
  if (state.status === "loading") return <p className="wl-state">{t("state.loading")}</p>;
  if (state.status === "error") return <p className="wl-state">{t("state.failed", { message: state.error ?? "" })}</p>;

  const devices = Array.isArray(status?.devices) ? status.devices : [];
  const others = devices.filter((device) => device.local !== true);

  return (
    <div className="wl-sync" data-enabled="true">
      <CardHead title={t("sync.title")} hint={t("sync.hint")}>
        <ChipGroup label={t("sync.title")}>
          <Chip active={false} disabled={busy !== null} onClick={() => void run("probe")}>{t("sync.probe")}</Chip>
          <Chip active={false} disabled={busy !== null} onClick={() => void run("push")}>{t("sync.pushNow")}</Chip>
          <Chip active={false} disabled={busy !== null} onClick={() => void run("pull")}>{t("sync.pullNow")}</Chip>
        </ChipGroup>
      </CardHead>

      {message === null ? null : (
        <p className="wl-hint" data-kind={`sync-${message.kind}`}>{message.text}</p>
      )}

      <dl className="wl-sync-meta">
        <dt>{t("sync.transport")}</dt>
        <dd>{status?.transport ?? "—"}</dd>
        <dt>{t("sync.lastPush")}</dt>
        <dd>{formatTime(status?.lastPushAt ?? 0, t("sync.never"))}</dd>
        <dt>{t("sync.lastPull")}</dt>
        <dd>{formatTime(status?.lastPullAt ?? 0, t("sync.never"))}</dd>
      </dl>

      <SyncSettings t={t} onSaved={settingsSaved} />
      <CredentialForm t={t} transport={status?.transport} onSaved={() => setRefreshKey((key) => key + 1)} />

      {status?.lastPushError ? <p className="wl-hint" data-kind="sync-error">{t("sync.failed", { message: status.lastPushError })}</p> : null}
      {status?.lastPullError ? <p className="wl-hint" data-kind="sync-error">{t("sync.failed", { message: status.lastPullError })}</p> : null}

      <CardHead title={t("sync.devices")} />
      {others.length === 0 ? (
        <p className="wl-hint">{t("sync.noDevices")}</p>
      ) : (
        <table className="wl-table">
          <thead>
            <tr>
              <th>{t("devices.title")}</th>
              <th>{t("sync.status")}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.key} data-device={device.key}>
                <td>{device.local === true ? t("devices.local") : device.name}</td>
                <td>
                  {device.stale === true
                    ? <span data-kind="stale">{t("devices.stale")}</span>
                    : device.local === true
                      ? t("sync.enabledOn")
                      : t("devices.rows", { n: formatInt(device.rows ?? 0) })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="wl-note">{t("sync.secretHint")}</p>
    </div>
  );
}
