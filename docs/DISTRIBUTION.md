# 開発ビルドと正式配布

## このリポジトリで自動化していること

`Build desktop apps` は push、pull request、手動実行で動きます。各 OS のネイティブランナーで、ロック済み依存関係のインストール、ユニットテスト、型検査、レンダラーのビルド、パッケージ生成を実行します。Linux では Chromium 上の UI テストも行います。

| ランナー | 出力 |
| --- | --- |
| Windows | x64 NSIS インストーラー |
| macOS | arm64 / x64 の DMG と ZIP |
| Linux | x64 AppImage と deb |

成果物と SHA-256 を GitHub Actions Artifacts に 14 日保存します。GitHub Releases、ストア、自動更新サーバーなどへの公開はしません。GitHub token は `contents: read` のみで、checkout は資格情報を残しません。

すべてを 1 台の OS から生成・検証できる前提にしません。とくに macOS のコード署名は macOS が必要です。詳細は [electron-builder のマルチプラットフォーム手順](https://www.electron.build/v26/docs/features/multi-platform-build/) を参照してください。

## 署名・公証が未設定

現在は以下が未設定です。

- Apple Developer ID による配布用署名。
- Apple の notarization と stapling。
- Windows の Authenticode 署名。
- 公開 Release と署名済み成果物の配布。

`mac.identity: null`、`mac.notarize: false` と CI の `CSC_IDENTITY_AUTO_DISCOVERY: false` は、開発ビルドで署名できたかのように誤認しないための明示設定です。将来の正式配布では、この設定を署名ありの構成に変更し、署名失敗時にビルドを止める設定を導入する必要があります。秘密鍵・証明書・パスワードはリポジトリに置かず、承認された安全な資格情報管理で扱ってください。

署名なしでは OS が警告やブロックを行うことがあります。公証・署名をまだ終えていないビルドを「すぐ安全にインストールできる正式版」として案内しないでください。

参考: [electron-builder コード署名](https://www.electron.build/v26/docs/features/code-signing/)

## 公開前チェックリスト

この一覧は「確認済み」の宣言ではありません。正式配布前に、対象のコミット・ビルド番号・OS ごとの結果を記録します。

- [ ] ユーザー / リポジトリ管理者から公開 Release の承認を得る。
- [ ] Windows・Apple Silicon Mac・Intel Mac・Linux の対象環境でインストールと起動を確認。
- [ ] 普通のアプリでコピーしたテキストが取り込まれる。
- [ ] 既定キーで右側にカードが開き、変更したキーでも呼び出せる。
- [ ] 競合するキーの登録失敗がユーザーに表示される。
- [ ] トレイ / メニューバー、閉じる・再表示、終了、2 回目の起動が正しく動く。
- [ ] カードの選択はコピーだけを行い、入力先へ勝手に貼り付けない。
- [ ] 秘密を含まないダミー値で、停止・再開・ロック・サスペンドからの復帰を検証。
- [ ] 既存クリップボードの初回取り込みをしない。
- [ ] 初期状態で履歴ファイルを作らず、終了後に履歴が残らない。
- [ ] 永続保存の警告、有効化・再起動・無効化・個別削除・全削除を確認。
- [ ] ピンを含む件数 / バイト上限を確認。
- [ ] 外部通信がないことを、通常操作中のネットワーク観察で確認。
- [ ] デュアルディスプレイ、高 DPI、画面端、短い画面、キーボード操作を確認。
- [ ] Linux の X11 とサポート対象の Wayland / portal 組み合わせを分けて確認。
- [ ] Windows 署名、macOS 署名・公証・stapling を検証。
- [ ] OS の警告を迂回せず、クリーンなユーザー環境へインストールできる。
- [ ] アップグレード・アンインストール、ユーザーデータが残る範囲を確認。
- [ ] 署名済み最終成果物で SHA-256 を再生成し、版番号とリリースノートを確認。

## ローカルでの生成

[README](../README.md#インストーラーを生成する) のコマンドを対象 OS 上で実行します。Linux のパッケージング依存関係として、CI では `libopenjp2-tools` を導入しています。ビルドツールは Electron バイナリや各プラットフォーム用ツールを追加取得する場合があります。

Linux の desktop identity は `jp.kuro0315.pupa.desktop` です。`package.json` の `desktopName` と Electron main の指定に加え、`linux.syncDesktopName: true` によりインストール先の `.desktop` 名を一致させています。アプリ名だけを変更する場合も、この識別子を安易に変えないでください。

参考: [electron-builder Linux のウィンドウ識別](https://www.electron.build/v26/docs/linux/)、[Electron Wayland ショートカット](https://www.electronjs.org/docs/latest/api/global-shortcut)

## アイコン

`assets/icon.svg` は Pupa 専用のオリジナルベクターです。各 OS 用の PNG / ICO / ICNS、macOS の monochrome template tray、インストーラー用画像を同梱しています。Python 3 + Pillow で `python scripts/generate-icons.py` を実行すると再生成できます。通常の CI はコミット済みの画像を使い、Python を必要としません。
