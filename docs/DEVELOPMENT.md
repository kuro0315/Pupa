# Pupa を開発する

Pupa 0.2 は **Tauri 2 + Rust + TypeScript / Vite** です。Electron、Node.js の常駐プロセス、Chromium の同梱はありません。表示には OS の WebView を使います。Node.js はフロントエンドの開発・ビルド時のみ必要です。

## 準備

- Node.js 24 / npm、Git、Rust stable。
- 対象 OS の [Tauri 開発前提条件](https://v2.tauri.app/start/prerequisites/)。Linux の GUI ビルドには WebKitGTK / GTK の開発パッケージなどが必要です。
- Windows: MSVC ビルドツールと WebView2。macOS: Xcode Command Line Tools。
- 対応する GUI セッション。Web プレビューだけでは OS 機能を確認できません。

```sh
git clone --branch feat/pupa-clipboard-cards https://github.com/kuro0315/Pupa.git
cd Pupa
npm ci
npm start
```

`npm start` は Tauri 開発版、`npm run dev` はブラウザー用 UI プレビューです。ブラウザーのデモは実際のクリップボード・トレイ・グローバルショートカットを使いません。

## 検証

```sh
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:ui
```

`npm test` は Rust の純粋コアテストです。実際の OS のクリップボードや、ユーザーのウィンドウ情報は読みません。GUI 依存のないコア検証と、実際の WebView / OS での確認を分けています。

Linux ネイティブ smoke は CI の隔離された Xvfb / D-Bus セッションで Tauri + WebKitWebDriver を使います。テスト専用にコンパイルしたバイナリと合成値だけを使用し、配布物にはテストコマンドを含めません。実 OS クリップボード API の試験も、自分で書いた合成値だけを読みます。普段使いのデスクトップでは実行しないでください。

## パッケージ

対象 OS の開発環境で実行します。出力は `src-tauri/target/` 配下の `bundle/` です。

```sh
# Windows x64
npm run dist -- --bundles nsis

# macOS: 対象 Rust ターゲットを先に用意
npm run dist -- --target aarch64-apple-darwin --bundles dmg
npm run dist -- --target x86_64-apple-darwin --bundles dmg

# Linux x64
npm run dist -- --bundles appimage,deb
```

署名資格情報・公証資格情報は未設定です。コマンドはインストーラーの生成であり、正式 Release の公開や署名の成功を意味しません。

## 構成

```text
src-tauri/src/       Rust の履歴、保存、監視、OS アダプター、コマンド
src-tauri/           Tauri 設定、最小 capability、Cargo.lock
renderer/           カード UI と限定された Tauri bridge
assets/             アプリとトレイの画像
scripts/            CI smoke、成果物とチェックサムの検証
tests/ui/           ブラウザーでの操作・表示検証
docs/               インストール、プライバシー、配布ガイド
.github/workflows/  各 OS のビルド・検証
```

Rust がクリップボード、ファイル保存、ショートカットを管理します。レンダラーには任意のファイル・シェル・HTTP・OS クリップボード操作を許可しません。外部ページへの遷移を拒否し、履歴本文は HTML ではなくテキストとして表示します。

## Electron 版からの移行

0.1 の Electron 版とは保存先が異なります。旧履歴を自動で読み込んだり削除したりしません。旧版を終了してから Tauri 版を起動してください。任意保存した旧履歴を消す場合は、旧版で削除するか、自分で旧データの保存先を確認してください。

## 参考

[Tauri clipboard](https://v2.tauri.app/plugin/clipboard/) · [global shortcut](https://v2.tauri.app/plugin/global-shortcut/) · [capabilities](https://v2.tauri.app/security/capabilities/) · [WebDriver](https://v2.tauri.app/develop/tests/webdriver/) · [配布](https://v2.tauri.app/distribute/)
