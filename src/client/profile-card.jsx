/**
 * AI 用户画像卡片（默认关闭时整卡不渲染）。
 *
 * 交互：挂载时先 probe（只问 enabled / 是否登录，不生成）；点「生成画像」才请求 /profile。
 * 失败一律由宿主降级为本地规则版，这里只展示 source / code，不弹错、不阻塞看板。
 * 结构复用 CardHead（标题 + 右侧 hint + 右上按钮），不另造卡片头。
 *
 * 展示结构（headline / dimensions / advice / risk）由 profile-view.js 归一化，
 * AI 版与本地规则版同构，降级时观感一致。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { formatInt } from "../format.js";
import { profileSections } from "../profile-view.js";
import { CardHead } from "./card-head.jsx";

const API_PATH = "/workload-report/v1";

/** 稳定错误码 → 文案键（静态表：保证 i18n 死键检查能扫描到每一条）。 */
const CODE_KEYS = {
  LLM_UNAVAILABLE: "profile.code.llmUnavailable",
  ACCOUNT_SIGN_IN_REQUIRED: "profile.code.signInRequired",
  MISSING_CREDENTIAL: "profile.code.missingCredential",
  AI_TIMEOUT: "profile.code.timeout",
  AI_NOT_STOPPED: "profile.code.notStopped",
  AI_PARSE_FAILED: "profile.code.parseFailed",
  AI_EMPTY_RESULT: "profile.code.emptyResult",
  AI_FAILED: "profile.code.failed",
};

/** 生成时间的小字格式：只到分钟，跟随界面语言。 */
function timeText(ms, lang) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return "";
  try {
    return new Date(Number(ms)).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * @param props.t - 翻译函数。
 * @param props.lang - zh | en（决定文案与缓存语言）。
 * @param props.days - 当前区间天数。
 * @param props.scope - all | main | subagent。
 * @param props.allTime - 是否「全部」区间。
 * @param props.tz - 当前时区。
 */
export function ProfileCard({ t, lang = "zh", days, scope, allTime = false, tz }) {
  // probing：只探状态；disabled：配置关闭，整卡不渲染；ready：可生成或已生成。
  const [status, setStatus] = useState("probing");
  const [profile, setProfile] = useState(null);
  const [signedOut, setSignedOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  const queryOf = useCallback((probe) => {
    const params = new URLSearchParams({
      days: String(days),
      scope: String(scope ?? "all"),
      tz: String(tz ?? ""),
      lang,
    });
    if (allTime) params.set("all", "1");
    if (probe) params.set("probe", "1");
    return params;
  }, [days, scope, tz, lang, allTime]);

  useEffect(() => {
    let cancelled = false;
    const id = requestId.current + 1;
    requestId.current = id;
    setProfile(null);
    setFailed(false);
    setSignedOut(false);
    setStatus("probing");
    const controller = new AbortController();
    fetch(`${API_PATH}/profile?${queryOf(true).toString()}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled || requestId.current !== id) return;
        if (body === null || body?.enabled !== true) {
          setStatus("disabled");
          return;
        }
        setSignedOut(body.signedIn === false);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled && requestId.current === id) setStatus("disabled");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [queryOf]);

  const generate = useCallback(async () => {
    if (status === "probing" || status === "disabled" || status === "generating") return;
    const id = requestId.current + 1;
    requestId.current = id;
    setStatus("generating");
    setFailed(false);
    const params = queryOf(false);
    // 已有结果时按钮是「重新生成」→ force=1，跳过指纹缓存。
    if (profile !== null) params.set("force", "1");
    try {
      const response = await fetch(`${API_PATH}/profile?${params.toString()}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (requestId.current !== id) return;
      if (body?.enabled !== true) {
        setStatus("disabled");
        return;
      }
      setProfile(body);
      setSignedOut(body.code === "ACCOUNT_SIGN_IN_REQUIRED" || body.code === "MISSING_CREDENTIAL");
      setStatus("ready");
    } catch {
      if (requestId.current !== id) return;
      setFailed(true);
      setStatus("ready");
    }
  }, [status, queryOf, profile]);

  if (status === "probing" || status === "disabled") return null;

  const generating = status === "generating";
  const source = profile?.source;
  const codeKey = profile?.code === null || profile?.code === undefined ? null : CODE_KEYS[profile.code] ?? null;
  const usage = profile?.usage;
  const generatedAt = profile?.generatedAt;
  const timestamp = timeText(generatedAt, lang);
  const view = profile === null ? null : profileSections(profile);

  return (
    <div className="wl-card wl-profile-card" data-kind="ai-profile" data-section="profile" data-source={source ?? undefined} aria-busy={generating}>
      <CardHead title={t("profile.title")} hint={t("profile.hint")}>
        <button
          type="button"
          className="wl-btn"
          data-kind="primary"
          disabled={generating}
          onClick={generate}
        >
          {profile === null ? t("profile.generate") : t("profile.regenerate")}
        </button>
      </CardHead>

      {signedOut ? <p className="wl-status" data-kind="profile-signin">{t("profile.signIn")}</p> : null}
      {generating ? <p className="wl-state" data-kind="profile-generating">{t("profile.generating")}</p> : null}
      {failed ? <p className="wl-status" data-tone="error">{t("profile.requestFailed")}</p> : null}

      {profile === null && !generating ? <p className="wl-hint">{t("profile.intro")}</p> : null}

      {view !== null ? (
        <>
          <div className="wl-profile-meta">
            <span className="wl-profile-source" data-source={source}>
              {source === "llm" ? t("profile.source.llm") : t("profile.source.local")}
            </span>
            {codeKey === null ? null : <span className="wl-status" data-tone="error">{t(codeKey)}</span>}
          </div>

          {view.headline === "" ? null : (
            <p className="wl-profile-headline" data-kind="profile-headline">{view.headline}</p>
          )}

          {view.dimensions.length === 0 ? null : (
            <ul className="wl-profile-dims" data-kind="profile-dimensions">
              {view.dimensions.map((item, index) => (
                <li className="wl-profile-dim" data-key={item.key} key={`${index}-${item.key}-${item.title}`}>
                  <div className="wl-profile-dim-head">
                    <span className="wl-profile-dim-title">{item.title}</span>
                    <span className="wl-profile-dim-insight">{item.insight}</span>
                  </div>
                  {item.evidence === "" ? null : (
                    <p className="wl-profile-dim-evidence" data-kind="profile-evidence">{item.evidence}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {view.risk === null ? null : (
            <p className="wl-profile-risk" data-kind="profile-risk">
              <strong>{t("profile.risk")}</strong>
              {view.risk}
            </p>
          )}

          {view.advice.length === 0 ? null : (
            <div className="wl-profile-advice-list" data-kind="profile-advice">
              <strong className="wl-profile-advice-label">{t("profile.advice")}</strong>
              {view.advice.map((item, index) => (
                <div className="wl-profile-advice-item" key={`${index}-${item.text}`}>
                  <span className="wl-profile-advice-text">{item.text}</span>
                  {item.why === "" ? null : <span className="wl-profile-advice-why">{item.why}</span>}
                </div>
              ))}
            </div>
          )}

          <p className="wl-hint wl-hint-spaced" data-kind="profile-usage">
            {source === "llm" && usage !== undefined
              ? t("profile.usage", {
                input: formatInt(usage.input),
                output: formatInt(usage.output),
                time: timestamp,
              })
              : t("profile.usage.local", { time: timestamp })}
          </p>
          {/* 输出被截断但 JSON 修复成功：卡片底部一行小字说明（不打断阅读、不弹错） */}
          {profile?.truncated === true ? (
            <p className="wl-hint wl-hint-spaced" data-kind="profile-truncated">{t("profile.truncated")}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
