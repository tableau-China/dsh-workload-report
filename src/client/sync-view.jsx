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
import {
  FREQUENCY_NOTE_KEYS, FREQUENCY_OPTIONS, FREQUENCY_TEXT_KEYS, ICON_TEXT_KEYS, checkMachineIdentity,
  configureIconState, deviceRenameReport, manualSyncState, normalizeFrequency, pathPreview, prefixOf, shortDeviceId,
} from "./sync-state.js";

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

/** 自检结果的时间可读化（同 formatTime，never 时显示"从未"）。 */
function formatProbe(probe, never) {
  if (probe === null || probe === undefined || !probe.at) return never;
  return formatTime(probe.at, never);
}

/** 当前存储方式是否填了必填项（与宿主 applySettingsPatch 的必填校验同一口径）。 */
function transportConfigured(view, transport) {
  if (view === null || view === undefined) return false;
  if (transport === "cos") return (view.cos?.bucket ?? "").trim() !== "" && (view.cos?.region ?? "").trim() !== "";
  if (transport === "github" || transport === "gitea") return (view.github?.repo ?? "").trim() !== "";
  if (transport === "local") return (view.local?.dir ?? "").trim() !== "";
  return false;
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
  /**
   * 布局（2.3.3）：**左侧应用说明**、**右侧「设备」标签 + 筛选 chips + 「设备同步」按钮**挤在一起。
   * 不再复用 CardHead（它会标题最左、控件最右，中间空一大段）。
   */
  return (
    <div className="wl-device-row" data-kind="device-filter">
      {/* 左：一句话说明这个应用是做什么的 */}
      <div className="wl-app-desc" data-kind="app-desc">
        <p className="wl-app-desc-title">{t("panel.descTitle")}</p>
        <p className="wl-app-desc-body">{t("panel.descBody")}</p>
      </div>
      {/* 右：筛选标签 + chips + 入口按钮，紧挨在一起 */}
      <div className="wl-device-controls" data-kind="device-controls">
        {hasChips ? (
          <ChipGroup label={t("devices.title")}>
            <span className="wl-device-label" title={t("devices.hint")} data-kind="devices-label">{t("devices.title")}</span>
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
        {entry === null ? null : entry}
      </div>
    </div>
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
export function SyncSettingsDialog({ t, initialTransport = null, initialStatus = null, onSaved, onClose }) {
  const [state, setState] = useState({
    status: "loading", view: null, transports: [], presets: {}, cosRegions: [], canSave: false, error: null,
  });
  /** 宿主运行状态（enabled / transport / lastPushAt / lastPullAt / lastProbe / devices）。 */
  const [status, setStatus] = useState(initialStatus ?? null);
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [credentials, setCredentials] = useState({ status: "loading", vault: false, fields: [], error: null });
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  /** 正在执行的操作名（push / pull），只用于按钮文案；可用性判断统一看 busy。 */
  const [running, setRunning] = useState(null);
  const [message, setMessage] = useState(null);
  /** 同步频率：**本轮只预留界面**（6 小时为默认；12 小时 / 开机同步在下一版随后台周期一起打开）。 */
  const [frequency, setFrequency] = useState(normalizeFrequency(initialStatus?.syncFrequency));
  /** 最近一次自检结果（来自 /sync 的 status.lastProbe 或本页测试按钮），决定标题右侧的对号 / 圆圈 / 感叹号。 */
  const [probe, setProbe] = useState(initialStatus?.lastProbe ?? null);
  /** 基准设备 id：本弹窗第一次看到的本机 id（后续所有保存都跟它比对）。 */
  const [savedDeviceId, setSavedDeviceId] = useState(initialStatus?.devices?.find((d) => d.local === true)?.id ?? null);
  /** 已生效的同步频率（保存成功后更新；与表单不一致时提示"保存后生效"）。 */
  const [savedFrequency, setSavedFrequency] = useState(normalizeFrequency(initialStatus?.syncFrequency));
  /** 「高级选项」里的路径是否处于编辑态（默认只读）。 */
  const [pathEditing, setPathEditing] = useState(false);
  /** 保存前那次的本机显示名（用来提示"从 X 改成 Y，设备 id 不变"）。 */
  const [renamedFrom, setRenamedFrom] = useState(null);
  /** 自检请求进行中（按钮置灰 + 状态卡片显示"测试中…"）。 */
  const [probing, setProbing] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_PATH}/sync/settings`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      setState({ status: "ready", ...body, error: null });
      setForm(body.view);
      setBaseline(body.view);
      // 频率以**设置视图**为准（initialStatus 是看板状态，里面没有 syncFrequency）
      if (body.view?.syncFrequency !== undefined) {
        const freq = normalizeFrequency(body.view.syncFrequency);
        setFrequency(freq);
        setSavedFrequency(freq);
      }
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

  /** 弹窗内的运行状态（上次推送 / 拉取、最近自检、错误）：保存或手动同步后刷新。 */
  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_PATH}/sync`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const body = await response.json();
      setStatus(body.status ?? null);
      if (body.status?.lastProbe !== undefined) setProbe(body.status.lastProbe);
    } catch {
      /* 状态读不到不影响表单 */
    }
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

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
    // 同步频率是独立 state（不是 form 字段），变更时一并提交
    if (baseline !== null && normalizeFrequency(baseline.syncFrequency) !== frequency) {
      values.syncFrequency = frequency;
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
    // 改名不影响数据：设备身份是 id（.anonymous-user-id），这里只留档用于界面提示
    setRenamedFrom(baseline?.machineName ?? "");
    try {
      // **身份防回归**：只有 DSH_HOME 被换掉（换账户/换安装/删了 id 文件）才会变 id。
      // 一旦变了，改名字也不该悄悄把历史数据切成两台设备 → 先拦下来让用户知情。
      let currentId = localDeviceId;
      try {
        const probeStatus = await fetch(`${API_PATH}/sync`, { headers: { accept: "application/json" } }).then((r) => r.json());
        currentId = probeStatus?.status?.devices?.find((device) => device.local === true)?.id ?? currentId;
      } catch { /* 读不到就不拦（不阻断保存） */ }
      const identity = checkMachineIdentity(savedDeviceId ?? localDeviceId, currentId);
      if (identity.ok !== true) {
        setMessage({ kind: "fail", text: t("set.deviceIdChanged", { from: shortDeviceId(identity.previous), to: shortDeviceId(identity.current) }) });
        setBusy(false);
        return;
      }
      // 本次解析出的 id 成为后续比对的基准（改名不会走到这里的分支）
      if (identity.current.length > 0 && savedDeviceId !== identity.current) setSavedDeviceId(identity.current);
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
        if (body.view?.syncFrequency !== undefined) setSavedFrequency(normalizeFrequency(body.view.syncFrequency));
      }

      const filled = Object.fromEntries(
        Object.entries(draft).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
      );
      const hasCredentials = Object.keys(filled).length > 0;
      const deletion = draft.__delete === true;
      let credentialText = null;
      // 设置这一步已经成功：先给出确定文案，凭据那一步再覆盖成最终结果
      setMessage({ kind: "ok", text: t("set.saved") });
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
          credentialText = t("set.saved");
        } else {
          // 设置已经保存成功，只是连接没通：用「部分成功」的文案，别让用户以为整次保存失败
          credentialText = t("set.savedCredFail", { message: body.probe?.message ?? "?" });
        }
      }

      const okText = credentialText === null || credentialText === t("set.saved") || credentialText === t("cred.cleared");
      setMessage({ kind: okText ? "ok" : "fail", text: credentialText ?? t("set.saved") });
      await loadCredentials();
      if (typeof onSaved === "function") onSaved();
      // 配置后**立即自检**：同步已开启才测（关闭时宿主会拒绝写凭据、也连不出去）
      if (savedView?.enabled === true) await runProbe({ silent: true });
    } catch (error) {
      setMessage({ kind: "fail", text: t("set.saveFail", { message: String(error?.message ?? error) }) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 测试连接：走宿主 /sync?action=probe。
   * 结果写进 `probe`（供状态卡片与标题图标使用），`silent` 时只在卡片里显示、不额外弹提示。
   */
  const runProbe = useCallback(async ({ silent = false } = {}) => {
    setProbing(true);
    if (!silent) setMessage(null);
    try {
      const response = await fetch(`${API_PATH}/sync?action=probe`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const result = body.result ?? {};
      setProbe({ ...result, at: Date.now() });
      if (!silent) {
        setMessage(result.ok === true
          ? { kind: "ok", text: t("sync.probeOk") }
          : { kind: "fail", text: `${t("sync.probeFail")}（${result.code ?? "?"}）` });
      }
      return result;
    } catch (error) {
      const failure = { ok: false, code: "ERROR", message: String(error?.message ?? error), at: Date.now() };
      setProbe(failure);
      if (!silent) setMessage({ kind: "fail", text: t("sync.failed", { message: failure.message }) });
      return failure;
    } finally {
      setProbing(false);
      void loadStatus();
    }
  }, [t, loadStatus]);

  /**
   * 手动推送 / 拉取（迁移自旧「设备同步」页，现在只在弹窗里出现）。
   *
   * 注意 `busy` 是**布尔**（true = 有操作在跑）。2.0.5 之前的 bug：这里把操作名塞进了 busy、
   * 结束时空值复位，而按钮判断写的是「busy 不为空」——于是 `null` 与 `false` 语义打架，
   * 三个按钮**永久置灰**、怎么点都没反应。现在 busy 只存布尔，操作名另存 `running`（仅用于按钮文案）。
   */
  const runSync = useCallback(async (action) => {
    setBusy(true);
    setRunning(action);
    setMessage(null);
    try {
      const response = await fetch(`${API_PATH}/sync?action=${action}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const result = body.result ?? {};
      setMessage(result.ok === true
        ? { kind: "ok", text: action === "push" ? t("sync.pushOk", { n: formatInt(result.rows ?? 0) }) : t("sync.pullOk", { n: formatInt(result.fetched ?? 0) }) }
        : { kind: "fail", text: t("sync.failed", { message: result.error ?? "?" }) });
      await loadStatus();
      if (result.ok === true && typeof onSaved === "function") onSaved();
    } catch (error) {
      setMessage({ kind: "fail", text: t("sync.failed", { message: String(error?.message ?? error) }) });
    } finally {
      setRunning(null);
      setBusy(false);
    }
  }, [t, onSaved, loadStatus]);

  const canSave = state.canSave === true && form !== null;
  /** 仓库类（GitHub / Gitea）才有右列（仓库 / 服务地址 / 分支）。 */
  const isRepoTransport = transport === "github" || transport === "gitea";
  /**
   * **已生效**的同步开关：来自宿主 /sync 的 status.enabled（= SyncService.canPush/canPull 的依据）。
   * 「立即推送 / 立即拉取」必须按它判断，而不是按表单里**还没保存**的 form.enabled——
   * 否则"同步早就开着、只是打开弹窗又点了一下开关看起来是关的"时，按钮会莫名其妙置灰。
   */
  const savedEnabled = status?.enabled === true || initialStatus?.enabled === true;
  /** 三个按钮的可用态统一由 manualSyncState 推导（只认已生效配置，不认未保存的表单开关）。 */
  const pushState = manualSyncState({ enabled: savedEnabled, busy });
  const probeState = manualSyncState({ enabled: savedEnabled, busy, probing, needsProbe: true });
  /** 表单与已生效配置不一致（改了没保存）→ 提示"保存后生效"，但按钮仍可点（手动同步走已生效配置）。 */
  const pendingSave = form !== null && form.enabled !== savedEnabled;

  /** 已登记设备（本机 + 拉到的其它设备），以及本机设备 id —— 用于「改名字不会断数据」的说明。 */
  const deviceList = Array.isArray(status?.devices) ? status.devices : [];
  const localDeviceId = deviceList.find((device) => device.local === true)?.id ?? null;
  /** 保存时的改名说明（只在确实改过名字、且保存成功后展示）。 */
  const renameInfo = renamedFrom === null
    ? null
    : deviceRenameReport(deviceList, renamedFrom, form?.machineName ?? "");

  /** 图标语义：✓ 已配置并通过自检 / ! 连接失败 / ○ 未配置或未检查。 */
  const iconState = configureIconState({
    enabled: form?.enabled === true,
    configured: transportConfigured(form, transport ?? initialTransport),
    probeOk: typeof probe?.ok === "boolean" ? probe.ok : null,
  });
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
          <div className="wl-dialog-title">
            <h2 className="wl-title">{t("set.dialogTitle")}</h2>
            {/* 配置状态图标：✓ 已配置并通过自检 / ! 连接失败 / ○ 未配置或未检查 */}
            <span className="wl-state-icon" data-state={iconState} data-icon-state={iconState} title={t(ICON_TEXT_KEYS[iconState])} aria-label={t(ICON_TEXT_KEYS[iconState])} role="img">
              {iconState === "configured" ? "✓" : iconState === "failed" ? "!" : "○"}
            </span>
            <span className="wl-state-icon-text">{t(ICON_TEXT_KEYS[iconState])}</span>
          </div>
          <p className="wl-subtitle">{t("set.hint")}</p>
          <div className="wl-spacer" />
          {/* 测试连接在弹窗之内（配置后保存会自动测一次，这里可随时手动重测） */}
          <button
            type="button"
            className="wl-btn"
            data-action="probe-now"
            disabled={probeState.disabled}
            onClick={() => void runProbe()}
            title={savedEnabled ? t("sync.probe") : t("set.probeNeedEnable")}
          >
            {probing ? t("sync.probing") : t("sync.probe")}
          </button>
          <button type="button" className="wl-btn" onClick={onClose} disabled={busy} aria-label={t("action.close")}>✕</button>
        </header>

        {state.status === "error" ? <p className="wl-state">{t("state.failed", { message: state.error ?? "" })}</p> : (
          form === null ? <p className="wl-state">{t("state.loading")}</p> : (
            <div className="wl-body wl-dialog-body">
              {/* ① 设备：本机显示名（全局项）与**已登记设备**并列一行；设备身份是 id，改名字不会断数据 */}
              <div className="wl-form-global" data-row="device">
                <div className="wl-form-grid" data-block="device-row" data-cols="2">
                  <div className="wl-form-fields">
                    {text("machineName", t("set.machineName"), t("set.machineNameHint"), form.machineName, (v) => setField("machineName", v), "Mac mini")}
                  </div>
                  <div className="wl-form-fields" data-block="device-list">
                    <div className="wl-field-row" data-row="registered">
                      <span className="wl-field-label">
                        {t("set.registeredDevices")}
                        <span className="wl-field-hint">{t("set.registeredCount", { n: formatInt(deviceList.length) })}</span>
                      </span>
                      <span className="wl-device-chips">
                        {deviceList.length === 0 ? (
                          <span className="wl-hint" data-kind="sync-storage">{t("sync.noDevices")}</span>
                        ) : deviceList.map((device) => (
                          <span key={device.key ?? device.id ?? device.name} className="wl-device-chip" data-local={device.local === true ? "true" : undefined} data-device-id={device.id ?? ""} title={device.id ?? ""}>
                            <span className="wl-dot-mini" data-local={device.local === true ? "true" : undefined} aria-hidden="true" />
                            {device.name ?? device.id ?? "?"}
                          </span>
                        ))}
                      </span>
                    </div>
                  </div>
                </div>
                {/* 设备 id 保障：名字只是标签，身份认的是 DSH 的安装 id */}
                <p className="wl-hint" data-kind="device-identity">
                  {t("set.deviceIdHint", { id: shortDeviceId(localDeviceId) || t("set.deviceIdUnknown") })}
                </p>
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
                      // 2.0.5：不再显示「来自 DSH 凭据存储」这类来源小字（对使用者没有意义，只是噪音）。
                      // 「已配置 / 未配置」仍然保留——那才是用户需要知道的。
                      // 与连接参数同一套行式：左标题（带已配置状态），右输入框，一行一个
                      return (
                        <div key={field.id} className="wl-field-row">
                          <span className="wl-field-label">
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

              {/* ④b + ④c 左右两列：左「连接与同步状态」、右「同步频率」（2.3.1 减少纵向长度） */}
              <div className="wl-form-grid wl-sync-two-col" data-block="sync-status-frequency">
              <section className="wl-form-block" data-block="sync-status" aria-label={t("set.statusTitle")}>
                <h4 className="wl-form-section">{t("set.statusTitle")}</h4>
                {/* 一行：大号状态图标 + 结论 + 上次推送 / 拉取（同一行，紧凑） */}
                <div className="wl-sync-status" data-probe={probing ? "probing" : probe === null ? "none" : probe.ok === true ? "ok" : "fail"}>
                  <span
                    className="wl-status-badge"
                    data-state={probing ? "probing" : probe === null ? "unchecked" : probe.ok === true ? "configured" : "failed"}
                    data-badge-state={probing ? "probing" : probe === null ? "unchecked" : probe.ok === true ? "configured" : "failed"}
                    role="img"
                    aria-label={probing ? t("sync.probing") : probe === null ? t("sync.probeNever") : probe.ok === true ? t("sync.probeOk") : t("sync.probeFail")}
                  >
                    {probing ? "…" : probe === null ? "○" : probe.ok === true ? "✓" : "!"}
                  </span>
                  <div className="wl-sync-status-text">
                    <span className="wl-sync-status-main" data-kind={probing ? "sync-probing" : probe === null ? null : probe.ok === true ? "sync-ok" : "sync-error"}>
                      {probing
                        ? t("sync.probing")
                        : probe === null
                          ? t("sync.probeNever")
                          : probe.ok === true
                            ? t("set.probeOkShort")
                            : `${t("set.probeFailShort")}（${probe.code ?? "?"}）`}
                    </span>
                    <span className="wl-sync-status-last" data-block="sync-last-line">
                      {t("set.lastTimes", { push: formatTime(status?.lastPushAt ?? 0, t("sync.never")), pull: formatTime(status?.lastPullAt ?? 0, t("sync.never")) })}
                    </span>
                  </div>
                </div>
                {/* 失败时把原因单独一行（只在出错时占位，成功保持紧凑） */}
                {probe !== null && probe.ok === false && probe.message ? (
                  <p className="wl-hint" data-kind="sync-error">{probe.message}</p>
                ) : null}
                {status?.lastPushError ? <p className="wl-hint" data-kind="sync-error">{t("sync.failed", { message: status.lastPushError })}</p> : null}
                {status?.lastPullError ? <p className="wl-hint" data-kind="sync-error">{t("sync.failed", { message: status.lastPullError })}</p> : null}
              </section>

              {/* ④c 自动同步频率（2.2.0 正式启用）：选一个周期即可，保存后定时器立刻按新频率重建。
                  手动按钮始终保留（自动同步之外的兜底）。 */}
              <section className="wl-form-block" data-block="sync-frequency" aria-label={t("set.frequency")}>
                <h4 className="wl-form-section">{t("set.frequency")}</h4>
                <ChipGroup label={t("set.frequency")}>
                  {FREQUENCY_OPTIONS.map((item) => (
                    <Chip
                      key={item.id}
                      active={frequency === item.id}
                      data-frequency={item.id}
                      onClick={() => setFrequency(item.id)}
                    >
                      {t(FREQUENCY_TEXT_KEYS[item.id])}
                    </Chip>
                  ))}
                </ChipGroup>
                {/* 手动按钮跟在「仅手动」后面，且**只在选中手动时出现**（自动同步下不需要它们） */}
                <div className="wl-sync-manual" data-visible={frequency === "manual" ? "true" : "false"}>
                  {frequency === "manual" ? (
                    <>
                      <button type="button" className="wl-btn" data-action="sync-now-push" disabled={pushState.disabled} onClick={() => void runSync("push")}>
                        {running === "push" ? t("sync.pushing") : t("sync.pushNow")}
                      </button>
                      <button type="button" className="wl-btn" data-action="sync-now-pull" disabled={pushState.disabled} onClick={() => void runSync("pull")}>
                        {running === "pull" ? t("sync.pulling") : t("sync.pullNow")}
                      </button>
                    </>
                  ) : null}
                </div>
                <p className="wl-hint" data-kind="sync-frequency-note">
                  {t(FREQUENCY_NOTE_KEYS[frequency])}
                  {savedFrequency === frequency ? null : ` ${t("set.pendingSave")}`}
                </p>
              </section>
              </div>

              {/* ⑤ 高级选项（默认收起）：只有普通用户不用管、默认值即可的项 */}
              <section className="wl-form-block" data-block="advanced" aria-label={t("set.advanced")}>
                <h4 className="wl-form-section">{t("set.advanced")}</h4>
                {/* 路径默认只读（普通用户不用改），但**多台机器必须用同一个模板**才能互相看到——
                    所以给一个明确的「修改路径」入口：展开后可填，保存时宿主会校验必须含 {machineId}。 */}
                {pathEditing ? (
                  <div className="wl-field-row" data-row="path-edit">
                    <span className="wl-field-label">{t("set.path")}</span>
                    <input
                      type="text"
                      data-setting="path"
                      value={form.path ?? ""}
                      placeholder="dsh-workload-sync/machines/{machineId}.json"
                      onChange={(event) => setField("path", event.target.value)}
                    />
                  </div>
                ) : (
                  <div className="wl-field-row" data-row="path-readonly">
                    <span className="wl-field-label">{t("set.path")}</span>
                    <code className="wl-path-preview" data-path-template={form.path ?? ""}>{pathPreview(form.path, { machineId: localDeviceId ? shortDeviceId(localDeviceId).replace("…", "") : "" })}</code>
                  </div>
                )}
                <p className="wl-hint" data-kind="path-location">{t("set.pathLocation", { dir: prefixOf(form.path) })}</p>
                <button type="button" className="wl-btn" data-action="toggle-path-edit" aria-expanded={pathEditing} onClick={() => setPathEditing((v) => !v)}>
                  {pathEditing ? t("set.pathEditDone") : t("set.pathEdit")}
                </button>
              </section>

              {state.canSave === true ? null : <p className="wl-hint" data-kind="sync-error">{t("set.noEditor")}</p>}
              {message === null ? null : <p className="wl-hint" data-kind={`sync-${message.kind}`}>{message.text}</p>}
              {/* 改过名字时明确告诉用户：身份没变、数据不断 */}
              {renameInfo === null || renameInfo.renamed !== true || message?.kind !== "ok" ? null : (
                <p className="wl-hint" data-kind="device-renamed">
                  {t("set.renamedOk", {
                    from: renameInfo.previousName === "" ? t("set.machineNameAuto") : renameInfo.previousName,
                    to: renameInfo.nextName === "" ? t("set.machineNameAuto") : renameInfo.nextName,
                    id: shortDeviceId(localDeviceId) || t("set.deviceIdUnknown"),
                  })}
                </p>
              )}
            </div>
          )
        )}

        <footer className="wl-dialog-foot">
          <button type="button" className="wl-btn" onClick={onClose} disabled={busy}>{t("set.cancel")}</button>
          <button type="button" className="wl-btn" data-kind="primary" data-action="save-all" disabled={!canSave || busy} onClick={() => void submit()}>
            {busy ? t("set.saving") : t("set.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
