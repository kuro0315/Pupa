# 開発ビルドと正式配布

## CI が行うこと

Tauri 2 + Rust のネイティブビルドを OS ごとに行います。`Build Tauri desktop apps` は PR、main への push、手動実行で動きます。npm / Cargo はロックファイルを使用し、Rust コアと bridge のテスト、型検査、デスクトップコードのコンパイル、パッケージ生成を検証します。

| ランナー | 出力 |
| --- | --- |
| Windows x64 | NSIS インストーラー |
| macOS Apple Silicon | arm64 DMG |
| macOS Intel | x64 DMG |
| Ubuntu 24.04 x64 | AppImage / deb |

Linux では Chromium の UI テストに加え、別途 Tauri + WebKitGTK のネイティブ smoke を行い、それぞれの実スクリーンショットを保存します。ネイティブ smoke は隔離した Xvfb / D-Bus とテスト専用バイナリを使用し、実ユーザーのクリップボード・前面アプリを読みません。配布バイナリは `smoke-test` feature なしで別にビルドします。

成果物、`SHA256SUMS.txt`、ファイルごとのサイズ・ハッシュ・対象コミットを記録する `installer-manifest.json` を Actions Artifacts に14日保存します。GitHub へのサインインが必要です。GitHub Releases / ストア / 更新サーバーへの公開は行いません。CI token は `contents: read` のみです。

## 署名・公証

Apple Developer ID / notarization と Windows Authenticode の資格情報は未設定です。OS の警告・ブロックが発生し得ます。「安全にすぐインストールできる正式版」とは案内しません。OS の保護を無効にしたり、警告を迂回したりしないでください。

正式配布には、承認された証明書の安全な管理、署名・公証、対象 OS の実機検証が必要です。秘密鍵・証明書・パスワードをリポジトリへ置かないでください。

[Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) · [Windows signing](https://v2.tauri.app/distribute/sign/windows/)

## 容量比較の読み方

Electron 0.1 と Tauri 0.2 は、同じ形式・CPU のインストーラーの実ファイルサイズで比較します。ZIP に複数の形式・CPUをまとめた総容量同士の比較はしません。Windows の WebView2 や Linux の WebKitGTK がシステムに既にあるかによって、初回インストール時の総ダウンロード量は変わります。

パッケージの縮小は、常駐 RAM / CPU 消費の測定値ではありません。メモリ使用量について数値を案内する場合は、同じ OS・同じ履歴件数・同じ操作条件で別に測定します。

## 公開前チェックリスト

以下は全項目が確認済みという宣言ではありません。

- [ ] 管理者が公開 Release を承認。
- [ ] Windows・Apple Silicon Mac・Intel Mac・Linux でインストール・起動・終了を実機確認。
- [ ] 未設定の WebView2 / WebKitGTK 依存関係とオフライン時の挙動を確認。
- [ ] コピー検出、ショートカットの変更・競合、トレイ、2回目の起動を確認。
- [ ] 右端の広い扇、ホバー拡大、短い/縦長画面、高DPI、複数モニターを確認。
- [ ] コピー成功時のみ閉じ、失敗時にはエラーとカードが残る。
- [ ] 歯車はコピーせず設定を開く。設定の取消、上限削減の確認を検証。
- [ ] 停止・再開・ロック・スリープ復帰後の既存値スキップを合成データで検証。
- [ ] macOS の機密マーカー尊重と、アプリ情報取得失敗時の不明表示を確認。
- [ ] 任意保存の警告、再起動、保存解除、個別削除、ピンを含む全削除を確認。
- [ ] Linux X11 とサポートする Wayland 環境を個別に確認。
- [ ] 外部通信なし、権限の最小化、production バイナリにテストコマンドなしを確認。
- [ ] 署名・公証とハッシュを検証。警告の回避なしでインストールできる。
- [ ] 更新・アンインストールとユーザーデータの残り方を確認。

## アイコンと画像

`assets/` と `build/` の画像は Pupa 用のオリジナルです。README のスクリーンショットは合成テキストを使用し、撮影したランタイムを明記します。実際のクリップボード本文を Issue や公開画像に載せないでください。

[開発・パッケージ手順](DEVELOPMENT.md) · [インストール](INSTALL.md) · [プライバシー](PRIVACY.md)
