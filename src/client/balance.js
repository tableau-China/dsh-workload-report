/**
 * 余额 chip 的展示模型（纯函数，客户端组件与离线同构量测共用一份判断）。
 *
 * 输入是宿主 `/balance`（以及快照 `balance` 字段）的状态对象：
 *   { enabled, supported, loggedIn, currency, amount, bonus, updatedAt, topUpUrl, usageUrl, error }
 * 输出只有四种界面状态（未启用时返回 null，表示"完全不渲染"）：
 *   ready       已登录  → "余额 ¥12.34" + 副文本 "赠送 ¥5.00"
 *   signedOut   未登录  → "未登录" + 充值链接
 *   error       请求失败 → "—" + 充值链接（不弹错）
 *   unsupported 服务不存在（老版 DSH）→ "当前 DSH 不支持"
 * 不引 React，避免"界面一套、测试一套"。
 */
import { formatMoney } from "../format.js";

/**
 * @param balance - 宿主 balance 字段；null / undefined = 还没拿到。
 * @param t - 翻译函数 `(key, vars) => string`。
 * @returns {null | { kind: string, text: string, sub: string|null, link: { href: string, label: string }|null }}
 */
export function balanceChip(balance, t) {
  if (balance === null || balance === undefined || balance.enabled !== true) return null;
  const topUp = typeof balance.topUpUrl === "string" && balance.topUpUrl !== ""
    ? { href: balance.topUpUrl, label: t("balance.topUp") }
    : null;
  // 服务不存在（老版 DSH）：只报"不支持"，本地拿不到链接，也没有服务可查
  if (balance.supported !== true) {
    return { kind: "unsupported", text: t("balance.unsupported"), sub: null, link: null };
  }
  if (typeof balance.error === "string" && balance.error !== "") {
    return { kind: "error", text: "—", sub: null, link: topUp };
  }
  if (balance.loggedIn !== true) {
    return { kind: "signedOut", text: t("balance.signedOut"), sub: null, link: topUp };
  }
  const amount = formatMoney(balance.amount, balance.currency);
  const bonus = balance.bonus === null || balance.bonus === undefined
    ? null
    : t("balance.bonus", { amount: formatMoney(balance.bonus, balance.currency) });
  return { kind: "ready", text: `${t("balance.label")} ${amount}`, sub: bonus, link: null };
}
