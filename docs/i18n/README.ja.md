# DSH ワークロードレポート — 作業時間とトークン使用量を可視化する DeepSeek Harness プラグイン

> **「実際の作業時間」と「トークン使用量」を同じ画面で可視化** — 日付別・ワークスペース別に、カレンダーヒートマップ、時間帯分析、ワークスペース比率、モデル使用量、そして顧客にそのまま送れる**自己完結型 HTML レポート**を。
> DeepSeek Harness（DSH）プラグイン。日本語を含む 8 言語の UI に対応。

[![npm](https://img.shields.io/npm/v/dsh-workload-report?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-workload-report)
[![license](https://img.shields.io/github/license/tableau-China/dsh-workload-report?style=flat-square)](../../LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/tableau-China/dsh-workload-report/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tableau-China/dsh-workload-report/actions)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js)](https://nodejs.org)

[English](../../README.md) · [中文](./README.zh-CN.md) · **[日本語](./README.ja.md)** · [Deutsch](./README.de.md) · [Français](./README.fr.md) · [Español](./README.es.md) · [Русский](./README.ru.md) · [Português](./README.pt.md)

![DSH ワークロードレポート](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png)

*看板: KPI カード、カレンダーヒートマップ、時間帯分析、ワークスペース比率。*

## これは何か

DSH（DeepSeek Harness）は現在のセッションの統計行だけを表示します。この DSH プラグインは、セッション・プロジェクト・期間をまたいだ視点を追加します。

どの日・どのワークスペースに作業時間を使ったか、何時台に集中できたか、どのモデルがトークン（Token）使用量を消費したか、概算コストはいくらか。さらに、顧客・チーム・月次レビューにそのまま送れる自己完結型 HTML レポートを書き出せます。

看板・レポート・AI ユーザープロファイル・同期ダイアログは、日本語を含む 8 言語の UI に追従します。DSH の表示言語を切り替えるとリアルタイムに反映されます。

## 主な機能

- **作業時間とトークンの二軸**：実作業時間（モデル時間 + ツール時間 − ユーザー待ち）とトークン使用量を同じ画面に表示。看板とレポートが同じ定義で集計するため、数字が食い違いません。
- **日付・ワークスペース・モデル・セッション別の内訳**：カレンダーヒートマップ、時間帯別のトークン出力 / ターン数、ワークスペース比率（時間 / トークン切替）、モデル別ツリーマップ・日別トレンド・明細表。
- **モデルの速度・TTFT・概算コスト**：出力速度 tok/s、TTFT、キャッシュヒット率、公式公開価格にもとづく概算コスト（価格のあるモデルのみ。請求書ではありません）。
- **顧客にそのまま送れる自己完結型 HTML レポート**：単一ファイル、インライン CSS + SVG、スクリプトなし・外部リソースなし。`anonymize=1` でワークスペース名とセッションタイトルを匿名化できます。
- **AI ユーザープロファイル（既定で含む・手動トリガー）**：集計統計だけを送信し、会話本文・タイトル・パスは送りません。「生成」を押したときだけモデルを呼び、失敗時はローカルルールにフォールバックします。
- **複数デバイス同期（既定オフ）**：COS・GitHub・Gitea・共有フォルダーの 4 種類から選択。複数マシンの利用状況を 1 つのレポートに統合できます。
- **8 言語 UI（DSH の表示言語に追従）**：日本語・英語・中国語・スペイン語・フランス語・ドイツ語・ロシア語・ポルトガル語（ブラジル）。プラグイン側に言語設定はありません。
- **公式インターフェースのみ・既定で外部送信なし**：統計はすべて本機に保存。読み取り専用 HTTP ルートのみを登録し、既定で外部へのリクエストを行いません。

## インストール

```bash
# npm（公開パッケージ）
dsh plugin add dsh-workload-report

# または GitHub から直接インストール
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main
```

インストール後に Web プロファイルを再起動してください。入口は**サイドバー下部**に表示されます（表示名は DSH の UI 言語に追従します）。

アンインストール: `dsh plugin --profile web remove dsh-workload-report`。

このバージョンは 1738 件のオフラインアサーションと、8 言語の i18n チェックで検証されています。

## リンク

- [English README](../../README.md)
- [中文 README](./README.zh-CN.md)
- [指標の定義（docs/metrics.md）](../metrics.md)
- [多言語の仕組み（docs/i18n.md）](../i18n.md)
- [複数デバイス同期（docs/sync.md）](../sync.md)
- [変更履歴（CHANGELOG.md）](../../CHANGELOG.md)
- [ブログ記事](https://vizwise.cn/posts/dsh-workload-report)
- [ライセンス（MIT）](../../LICENSE)

**キーワード**：DeepSeek Harness, DSH プラグイン, トークン使用量, 作業時間, ワークスペース別集計, カレンダーヒートマップ, 時間帯分析, AI ユーザープロファイル, デバイス同期
