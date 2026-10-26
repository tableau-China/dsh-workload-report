/**
 * 「设备同步」页签：状态 / 自检 / 手动同步 / 设备清单，以及**同步设置对话框**。
 *
 * 设计约束（见 docs/ui-conventions.md）：
 *   · 切换控件只用 ChipGroup + Chip，卡片头只用 CardHead；
 *   · 颜色只用宿主主题 token，不写死色值；
 *   · 默认关闭（sync.enabled=false）时**整页只渲染一句提示**，不显示空表格与假状态；
 *   · 凭据永不在界面回显，只显示「已读取 / 未找到」这类存在性信息。
 *
 * 2.0.2 布局调整（用户要求）：
 *   · 存储方式 / 连接参数 / 凭据**合并在同一个对话框**里，一屏填完、一次保存；
 *   · 表单内容**左右两列**（宽屏两列，<=720px 单列）；
 *   · 「文件路径模板」「抹掉路径」这类普通用户看不懂、默认值即可的项，
 *     收进折叠的「高级选项」并放在最后；
 *   · 「抹掉路径」不再作为设置项展示（默认关闭 = 路径照原样同步，配置项仍保留在 YAML 里可手改）。
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
 * 同步设置对话框：存储方式 + 连接参数 + 凭据（一个表单、两列、一次保存）。
 *
 * 为什么合并到一个对话框：
 *   原先「同步设置」与「凭据」是两张卡、两个保存按钮，用户要来回看「我填到哪了」；
 *   合并后一次填完、一个「保存」——先写设置（profile，热应用），再写凭据（DSH 凭据存储），
 *   最后统一报一次结果（设置是否保存 + 连接自检是否通过）。
 *
 * 安全约定：
 *   · 提交换行后立刻清空凭据输入框，值只存在于 POST 请求体里；
 *   · 已配置的凭据字段**不回填**（placeholder 提示「留空表示保持不变」）；
 *   · 界面只显示「已配置 / 未配置」与来源，从不回显内容。
 *
 * @param initialTransport - 打开对话框时的存储方式（来自 /sync 状态）；null 时用设置里的现值。
 * @param onSaved - 保存成功后回调（刷新状态 + 让看板重拉快照）。
 * @param onClose - 关闭对话框。
 */
export function SyncSettingsDialog({ t, initialTransport = null, onSaved, onClose }) {
  const [state, setState] = useState({
    status: "loading", view: null, transports: [], presets: {}, cosRegions: [], canSave: false, error: null,
  });
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [credentials, setCredentials] = useState({ status: "loading", vault: false, fields: [], error: null });
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  /** 「高级选项」默认收起：路径模板等项默认值即可用，普通用户不必看。 */
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const transport = form?.transport ?? null;
  /** 凭据字段跟随**正在编辑**的存储方式（切到 COS 立刻显示 SecretId / SecretKey）。 */
  const credentialTransport = transport ?? initialTransport;

  const loadCredentials = useCallback(async () => {
    if (credentialTransport === null || credentialTransport === "local") {
      setCredentials({ status: "ready", vault: false, fields: [], error: null });
      return;
    }
    try {
      const response = await fetch(`${API_PATH}/sync/credentials?transport=${encodeURIComponent(credentialTransport)}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      // 同步未启用时宿主回 { enabled:false, fields:[] }：表单不渲染字段，但设置仍可保存
      setCredentials({ status: "ready", vault: body.vault === true, fields: body.fields ?? [], error: null });
    } catch (error) {
      setCredentials({ status: "error", vault: false, fields: [], error: String(error?.message ?? error) });
    }
  }, [credentialTransport]);

  useEffect(() => { void loadCredentials(); }, [loadCredentials]);

  const setField = (path, value) => setForm((previous) => {
    const next = { ...previous };
    const [head, leaf] = path.split(".");
    if (leaf === undefined) next[head] = value;
    else next[head] = { ...next[head], [leaf]: value };
    return next;
  });

  const changeTransport = (id) => {
    setDraft({}); // 换存储方式 = 换一套凭据，旧草稿不能带过去
    setForm((previous) => {
      const next = { ...previous, transport: id };
      const preset = state.presets?.[id];
      if (preset !== undefined) next.github = { ...next.github, ...preset };
      return next;
    });
  };

  /** 只提交**变化过**的字段：未改动的字段保持宿主侧现值，避免把没填的空串写进配置。 */
  const changedSettings = () => {
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
    return values;
  };

  /**
   * 一次保存：先设置、后凭据。
   * 设置失败就停下（凭据没必要写，写了也连不上）；凭据失败只报凭据那一步。
   */
  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const values = changedSettings();
      let savedView = form;
      if (Object.keys(values).length > 0) {
        const response = await fetch(`${API_PATH}/sync/settings`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ values }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
        savedView = body.view;
        setForm(body.view);
        setBaseline(body.view);
      }

      const filled = Object.fromEntries(
        Object.entries(draft).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
      );
      const hasCredentials = Object.keys(filled).length > 0;
      const deletion = draft.__delete === true;
      let credentialText = null;
      // 设置这一步已经成功：先给出确定文案，凭据那一步再覆盖成最终结果
      setMessage({ kind: "ok", text: t(SAVED_KEY) });
      if (hasCredentials || deletion) {
        const response = await fetch(`${API_PATH}/sync/credentials`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ ...(deletion ? { delete: true } : { values: filled }), transport: savedView?.transport ?? transport }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${response.status}`);
        setDraft({}); // 立刻清空输入框，值不再留在界面上
        if (deletion) {
          const stillExternal = (body.fields ?? []).filter((field) => field.fallbackSource === "env" || field.fallbackSource === "file");
          credentialText = stillExternal.length === 0
            ? t("cred.cleared")
            : t("cred.clearedButExternal", { fields: stillExternal.map((field) => field.label).join(", ") });
        } else if (body.probe?.ok === true) {
          credentialText = t(SAVED_KEY);
        } else {
          // 设置已经保存成功，只是连接没通：用「部分成功」的文案，别让用户以为整次保存失败
          credentialText = t("set.savedCredFail", { message: body.probe?.message ?? "?" });
        }
      }

      const okText = credentialText === null || credentialText === t(SAVED_KEY) || credentialText === t("cred.cleared");
      setMessage({ kind: okText ? "ok" : "fail", text: credentialText ?? t(SAVED_KEY) });
      await loadCredentials();
      if (typeof onSaved === "function") onSaved();
    } catch (error) {
      setMessage({ kind: "fail", text: t("set.saveFail", { message: String(error?.message ?? error) }) });
    } finally {
      setBusy(false);
    }
  };

  const canSave = state.canSave === true && form !== null;
  /** 仓库类（GitHub / Gitea）才有右列（仓库 / 服务地址 / 分支）。 */
  const isRepoTransport = transport === "github" || transport === "gitea";
  const helpKey = transport === "cos" ? "set.cosHelp" : transport === "local" ? "set.localHelp" : transport === "gitea" ? "set.giteaHelp" : "set.githubHelp";
  /**
   * 连接参数 / 凭据的**行式字段**：左侧标题（+ 灰色小字说明），右侧输入框，**一行一个、不换行**。
   * 两层网格一起用：外层两列放"行"，内层每行 `max-content | 1fr` —— 所以同一列里的标签和输入框
   * 起点自然对齐（所有标签等宽），不想换行就不会换行（输入框吃掉剩余宽度）。
   */
  const row = (id, label, hint, control) => (
    <div key={id} className="wl-field-row">
      <span className="wl-field-label">
        {label}
        {hint === null ? null : <span className="wl-field-hint">{hint}</span>}
      </span>
      {control}
    </div>
  );
  const text = (id, label, hint, value, onChange, placeholder) => row(
    id, label, hint,
    <input type="text" data-setting={id} placeholder={placeholder ?? ""} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />,
  );
  const select = (id, label, hint, value, onChange, options) => row(
    id, label, hint,
    <select data-setting={id} value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
      <option value="">—</option>
      {options.map((item) => <option key={item} value={item}>{item}</option>)}
    </select>,
  );

  /**
   * 连接参数：**左右两列、每列每行一个字段**（左标题 + 右输入框，不换行）。
   *   · COS      → 左列：存储桶名称 / 地域
   *   · 共享目录 → 左列：共享目录
   *   · GitHub / Gitea → 左列：仓库 / 服务地址；右列：分支
   * 仓库类也**只用左列**（3 个字段、两两一行更紧凑、也不留空列）；
   * 只有真的能凑成两列时才用两列，所以任何存储方式下都不会出现"左半屏空白"。
   */
  const connectionFields = (
    <>
      <div className="wl-form-grid" data-block="connection" data-cols={isRepoTransport ? "2" : "1"}>
        <div className="wl-form-fields">
          {transport === "cos" ? (
            <>
              {text("cos.bucket", t("set.bucket"), null, form.cos?.bucket, (v) => setField("cos.bucket", v), state.presets?.cos?.bucket ?? "my-sync-1250000000")}
              {select("cos.region", t("set.region"), t("set.regionHint"), form.cos?.region, (v) => setField("cos.region", v), state.cosRegions ?? [])}
            </>
          ) : null}
          {transport === "local" ? text("local.dir", t("set.dir"), null, form.local?.dir, (v) => setField("local.dir", v), "~/sync/dsh-workload") : null}
          {isRepoTransport ? (
            <>
              {text("github.repo", t("set.repo"), null, form.github?.repo, (v) => setField("github.repo", v), "owner/name")}
              {text("github.baseUrl", t("set.baseUrl"), null, form.github?.baseUrl, (v) => setField("github.baseUrl", v), "https://api.github.com")}
            </>
          ) : null}
        </div>
        <div className="wl-form-fields">
          {isRepoTransport ? text("github.branch", t("set.branch"), null, form.github?.branch, (v) => setField("github.branch", v), "main") : null}
        </div>
      </div>
      <p className="wl-note"><strong>{t("set.whereToGet")}</strong>：{t(helpKey)}</p>
    </>
  );

  return (
    <div
      className="wl-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("set.dialogTitle")}
      data-sync-dialog="true"
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="wl-dialog" data-busy={busy ? "true" : undefined}>
        <header className="wl-head">
          <div>
            <h2 className="wl-title">{t("set.dialogTitle")}</h2>
            <p className="wl-subtitle">{t("set.hint")}</p>
          </div>
          <div className="wl-spacer" />
          <button type="button" className="wl-btn" onClick={onClose} disabled={busy} aria-label={t("action.close")}>✕</button>
        </header>

        {state.status === "error" ? <p className="wl-state">{t("state.failed", { message: state.error ?? "" })}</p> : (
          form === null ? <p className="wl-state">{t("state.loading")}</p> : (
            <div className="wl-body wl-dialog-body">
              {/* ① 全局项：本机显示名只设一次，对四种存储方式都生效 → 放在存储方式 chips **上方** */}
              <div className="wl-form-global" data-row="device">
                <div className="wl-form-fields">
                  {text("machineName", t("set.machineName"), t("set.machineNameHint"), form.machineName, (v) => setField("machineName", v), "Mac mini")}
                </div>
              </div>

              {/* ② 存储方式 + 开启同步（只对当前存储方式生效的项全在下面） */}
              <div className="wl-dialog-top">
                <ChipGroup label={t("set.transport")}>
                  {(state.transports ?? []).map((item) => (
                    <Chip key={item.id} active={transport === item.id} data-transport={item.id} onClick={() => changeTransport(item.id)}>
                      {item.label}
                    </Chip>
                  ))}
                </ChipGroup>
                <ChipGroup label={t("set.enabled")}>
                  <Chip active={form.enabled === true} data-setting="enabled" onClick={() => setField("enabled", !form.enabled)}>
                    {form.enabled === true ? t("set.on") : t("set.off")}
                  </Chip>
                </ChipGroup>
              </div>

              {/* ③ 连接参数：左右两列，每个字段一行 */}
              <section className="wl-form-block" data-block="connection-section" aria-label={t("set.colConnection")}>
                <h4 className="wl-form-section">{t("set.colConnection")}</h4>
                {connectionFields}
              </section>

              {/* ④ 凭据：默认展开（不折叠），每个字段一行；存储方式不需要凭据时只留一句说明 */}
              <section className="wl-form-block" data-block="credential-section" aria-label={t("cred.title")}>
                <h4 className="wl-form-section">{t("cred.title")}</h4>
                {credentialTransport === "local" ? (
                  <p className="wl-hint" data-kind="sync-storage">{t("set.localHelp")}</p>
                ) : credentials.status === "loading" ? null : credentials.status === "error" ? (
                  <p className="wl-hint" data-kind="sync-error">{t("cred.saveFail", { message: credentials.error ?? "" })}</p>
                ) : credentials.fields.length === 0 ? (
                  <p className="wl-hint" data-kind="sync-storage">{t("cred.afterEnable")}</p>
                ) : (
                  <div className="wl-form-fields" data-block="credential-fields">
                    {credentials.vault === true ? null : <p className="wl-hint" data-kind="sync-storage">{t("cred.fileFallback")}</p>}
                    {credentials.fields.map((field) => {
                      const sourceKey = field.source === "vault" ? "cred.fromVault" : field.source === "file" ? "cred.fromFile" : field.source === "env" ? "cred.fromEnv" : null;
                      // 与连接参数同一套行式：左标题（带已配置状态 / 来源），右输入框，一行一个
                      return (
                        <div key={field.id} className="wl-field-row">
                          <span className="wl-field-label">
                            {field.label}
                            <span data-kind={field.configured ? "ok" : "missing"}>
                              {field.configured ? t("cred.configured") : t("cred.missing")}
                            </span>
                            {sourceKey === null ? null : <span className="wl-field-hint">{t(sourceKey)}</span>}
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
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="wl-btn"
                      data-action="cred-clear"
                      disabled={busy}
                      onClick={() => setDraft((previous) => ({ ...previous, __delete: true }))}
                      data-active={draft.__delete === true ? "true" : undefined}
                    >
                      {draft.__delete === true ? t("cred.clearPending") : t("cred.clear")}
                    </button>
                  </div>
                )}
              </section>

              {/* ⑤ 高级选项（默认收起）：只有普通用户不用管、默认值即可的项 */}
              <div className="wl-form-advanced" data-open={advancedOpen ? "true" : "false"}>
                <button
                  type="button"
                  className="wl-btn"
                  data-action="toggle-advanced"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  {advancedOpen ? t("set.advancedHide") : t("set.advanced")}
                </button>
                {advancedOpen ? (
                  <div className="wl-form-advanced-body">
                    {text("path", t("set.path"), null, form.path, (v) => setField("path", v), "machines/{machineId}.json")}
                    <p className="wl-hint">{t("set.pathHint")}</p>
                  </div>
                ) : null}
              </div>

              {state.canSave === true ? null : <p className="wl-hint" data-kind="sync-error">{t("set.noEditor")}</p>}
              {message === null ? null : <p className="wl-hint" data-kind={`sync-${message.kind}`}>{message.text}</p>}
              <p className="wl-note">{t("cred.why")}</p>
            </div>
          )
        )}

        <footer className="wl-dialog-foot">
          <p className="wl-hint" data-kind="sync-footnote">{t("cred.hint")}</p>
          <button type="button" className="wl-btn" onClick={onClose} disabled={busy}>{t("set.cancel")}</button>
          <button type="button" className="wl-btn" data-kind="primary" data-action="save-all" disabled={!canSave || busy} onClick={() => void submit()}>
            {busy ? t("set.saving") : t("set.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}


/**
 * 「设备同步」页主体（入口在设备筛选行右侧，见上面的 DeviceFilter）。
 *
 * 页面上只留**只读状态**（传输方式 / 上次推送 / 上次拉取 / 错误 / 设备清单）与三个操作，
 * 所有可编辑项都在 SyncSettingsDialog 里——页面不再堆表单。
 *
 * @param onChanged - 推送/拉取/保存成功后回调（让看板重新拉快照）。
 */
export function BySyncView({ t, onChanged }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const state = useSyncStatus(refreshKey);

  /**
   * 设置保存成功后的联动：刷新本页状态 + 让看板重拉快照。
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
  const dialog = dialogOpen
    ? <SyncSettingsDialog t={t} initialTransport={status?.transport ?? null} onSaved={settingsSaved} onClose={() => setDialogOpen(false)} />
    : null;
  const settingsButton = (
    <button type="button" className="wl-btn" data-kind="primary" data-action="open-sync-settings" onClick={() => setDialogOpen(true)}>
      {t("set.open")}
    </button>
  );

  // 默认关闭：仍然渲染设置入口（否则用户没有入口开启它），只是不显示设备表格
  if (state.status === "ready" && !enabled) {
    return (
      <div className="wl-sync" data-enabled="false">
        <CardHead title={t("set.title")} hint={t("set.hint")}>{settingsButton}</CardHead>
        <p className="wl-hint" data-kind="sync-disabled">{t("sync.disabled")}</p>
        {dialog}
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
        {settingsButton}
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
      {dialog}
    </div>
  );
}

/** 保存成功的统一文案键（集中引用一次，避免同一键在字典里被判成死键 / 各处写法漂移）。 */
const SAVED_KEY = "set.saved";
