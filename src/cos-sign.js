/**
 * 腾讯云 COS XML API 签名（q-sign-algorithm=sha1）。
 *
 * 注意：COS 对象存储用的是**自有签名**，不是通用云 API 的 TC3-HMAC-SHA256。
 * 见 https://cloud.tencent.com/document/product/436/7778
 *
 * 流程：
 *   KeyTime      = StartTimestamp;EndTimestamp
 *   SignKey      = HMAC-SHA1(SecretKey, KeyTime)            → hex 字符串
 *   HttpString   = method\nuri\nparams\nheaders\n           （method 小写）
 *   StringToSign = sha1\nKeyTime\nSHA1(HttpString)\n
 *   Signature    = HMAC-SHA1(SignKey, StringToSign)         → hex 字符串
 *   Authorization = q-sign-algorithm=sha1&q-ak=SecretId&q-sign-time=KeyTime
 *                 &q-key-time=KeyTime&q-header-list=HeaderList
 *                 &q-url-param-list=UrlParamList&q-signature=Signature
 *
 * UrlEncode：UTF-8，且额外编码 ! ' ( ) * 等；空格编码为 %20（不是 +）。
 */

import { createHash, createHmac } from "node:crypto";

/** COS 要求的 UrlEncode：unreserved 字符（A-Za-z0-9-_.~）之外全部百分号编码，十六进制大写。 */
export function cosUrlEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 把 key=value 映射编码成 COS 的 `k1=v1&k2=v2`（键按字典序），并返回 keys 列表。 */
function canonicalize(pairs) {
  const entries = Object.entries(pairs ?? {})
    .map(([key, value]) => [cosUrlEncode(key).toLowerCase(), cosUrlEncode(value ?? "")])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return {
    list: entries.map(([key]) => key).join(";"),
    text: entries.map(([key, value]) => `${key}=${value}`).join("&"),
  };
}

/**
 * 计算 COS 请求签名。
 * @param params.request - { method, uriPath, query, headers, secretId, secretKey, startAtMs, expiresMs }。
 *   · method     HTTP 方法（内部转小写）；
 *   · uriPath    请求路径，以 / 开头，需已编码；
 *   · query      查询参数对象（值为 string）；可为空；
 *   · headers    参与签名的头部对象（键名任意大小写，内部转小写）；host 必填；
 *   · startAtMs  签名起始时间（毫秒）；缺省当前时间；
 *   · expiresMs  有效期（毫秒）；缺省 1 小时。
 * @returns { authorization, keyTime, headerList, urlParamList }。
 */
export function cosSign({
  method,
  uriPath,
  query = {},
  headers,
  secretId,
  secretKey,
  startAtMs = Date.now(),
  expiresMs = 60 * 60 * 1000,
}) {
  const start = Math.floor(startAtMs / 1000);
  const end = Math.floor((startAtMs + expiresMs) / 1000);
  const keyTime = `${start};${end}`;

  const signKey = createHmac("sha1", secretKey).update(keyTime, "utf8").digest("hex");

  const urlParams = canonicalize(query);
  // 头部：key 小写、value 去首尾空白；host 必带
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalizedHeaders[key.toLowerCase()] = String(value ?? "").trim();
  }
  const headerParts = canonicalize(normalizedHeaders);

  const httpString = [
    String(method).toLowerCase(),
    uriPath,
    urlParams.text,
    headerParts.text,
    "", // 末尾换行
  ].join("\n");

  const stringToSign = ["sha1", keyTime, createHash("sha1").update(httpString, "utf8").digest("hex"), ""].join("\n");
  const signature = createHmac("sha1", signKey).update(stringToSign, "utf8").digest("hex");

  return {
    authorization:
      `q-sign-algorithm=sha1&q-ak=${secretId}` +
      `&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
      `&q-header-list=${headerParts.list}&q-url-param-list=${urlParams.list}` +
      `&q-signature=${signature}`,
    keyTime,
    headerList: headerParts.list,
    urlParamList: urlParams.list,
    signature,
  };
}
