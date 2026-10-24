<p align="center"><img src="assets/icon.svg" width="112" alt="Pupa の蝶のアイコン"></p>
<h1 align="center">Pupa</h1>
<p align="center"><strong>コピーした言葉に、ちいさな魔法を。</strong><br>画面の右端からカードがふわっとひらく、ローカルファーストのクリップボードマネージャー。</p>

Pupa は Electron + TypeScript で動く、本物のデスクトップアプリです。Web ページを開いたままにする必要はありません。普段は隠れていて、呼び出すとカードだけが画面右端から扇形に広がります。マウスを重ねたカードが大きくなり、内容を読みやすく表示します。

## できること

- **いつでもカードをひらく。** macOS は `⌘ ⇧ Space`、Windows / Linux は `Ctrl Shift Space`。呼び出しキーは設定から変更できます。
- **探して、コピー。** テキスト・URL・コードを検索し、カードを選ぶとクリップボードへ戻します。貼り付け先に戻り、いつもの `⌘ V` / `Ctrl V` で貼り付けます。
- **好きなものを残す。** ピン留め、個別削除、全履歴削除。履歴は標準 60 件、最大 100 件です。
- **必要なときだけ記録。** 記録の一時停止と再開、トレイ / メニューバーからの呼び出し。
- **保存しないのが初期設定。** 履歴はメモリ内だけ。終了・再起動すると消えます。必要な場合だけ、設定でローカル保存を有効にできます。
- **通信しない。** アカウント、クラウド同期、広告、テレメトリー、外部 AI、更新確認の通信はありません。

> 自動貼り付けやキー入力の代行は行いません。Pupa のためにアクセシビリティ権限を与える必要もありません。

## インストール

**現在のビルドは開発・検証用です。署名済みの正式リリースではありません。**

このリポジトリには Windows / macOS / Linux のインストーラーを生成する設定と CI があります。CI が成功すると、[Actions](https://github.com/kuro0315/Pupa/actions/workflows/desktop-build.yml) の該当実行に OS ごとの Artifacts が作られます。まだ成功した実行がない場合、ダウンロードできるインストーラーはありません。Artifacts と [Releases](https://github.com/kuro0315/Pupa/releases) は別物で、CI は Release を作成・公開しません。

| 使用しているパソコン | 選ぶファイル |
| --- | --- |
| Windows x64 | `Pupa-<version>-windows-x64-setup.exe` |
| Mac / Apple Silicon | `Pupa-<version>-mac-arm64.dmg` |
| Mac / Intel | `Pupa-<version>-mac-x64.dmg` |
| Linux x64 | `Pupa-<version>-linux-x86_64.AppImage` または `Pupa-<version>-linux-amd64.deb` |

1. [Actions](https://github.com/kuro0315/Pupa/actions/workflows/desktop-build.yml) で、使用したいコミットの成功した実行を開きます。
2. Artifacts から `Pupa-windows-…` / `Pupa-macos-…` / `Pupa-linux-…` をダウンロードし、ZIP を展開します。GitHub へのサインインとリポジトリの読み取り権限が必要です。保存期間は 14 日です。
3. 自分の OS と CPU に合うファイルを選びます。`SHA256SUMS.txt` も同梱しています。
4. [OS 別インストールガイド](docs/INSTALL.md) を確認してください。

### 署名について、大切なお知らせ

このプロジェクトには Windows の署名資格情報も、Apple Developer ID / notarization の資格情報も設定していません。**Windows SmartScreen や macOS Gatekeeper が警告・ブロックする可能性があります。** OS の保護を無効にしたり、警告を迂回したりしないでください。普段使いの配布版には、運営者による署名と macOS の公証、各 OS の実機検証が必要です。ハッシュの一致だけで開発元の信頼性が証明されるわけではありません。

安全な一般配布に向けた残作業は [配布チェックリスト](docs/DISTRIBUTION.md) にまとめています。

## 使いはじめる

1. Pupa を起動します。起動する前からクリップボードに入っていた内容は取り込みません。
2. 好きな文章をコピーします。約 700 ms ごとに変更を検出します。
3. ショートカット、またはトレイから Pupa をひらきます。
4. カードを選んで再コピーし、貼り付け先で通常の貼り付け操作をします。
5. パスワード、認証コード、秘密鍵などを扱う前は記録を一時停止してください。

URL もコードもテキストとして扱います。URL を自動で開いたり、コードを実行したりはしません。ピンも履歴件数に含みます。上限に達した場合はピン以外の古い項目を優先して削除し、全項目がピン留めされている場合は最も古いピンも削除対象になります。

### カードだけで操作する

通常画面には見出しやサイドバーを表示しません。カードにマウスを重ねると拡大し、小さな操作アイコンが現れます。

- 矢印キー: カードを選んで拡大。Enter: 再コピー。Esc: 閉じる。
- ホイール / PageUp・PageDown: 表示する履歴を移動。
- `Ctrl / ⌘ F` または `/`: 必要なときだけ検索を開く。
- `,` またはカードの設定アイコン、トレイの「設定」: 設定を開く。
- 透明な余白をクリック、または呼び出しショートカットを再度押す: 閉じる。

## プライバシーと制約

- **画像、ファイル、HTML / RTF などの書式は非対応。** テキスト表現がある場合だけ、そのプレーンテキストを扱います。
- **完全な記録ではありません。** 短い間隔での連続コピー、アプリ側の独自クリップボード形式、OS の制限によって取りこぼすことがあります。
- 1 件あたり UTF-8 で 64 KiB、履歴全体で 2 MiB が上限です。大きすぎる内容は履歴に入りません。
- 一時停止中はクリップボードを読みません。再開時の既存内容も取り込まず、次の変更から記録します。対応 OS の画面ロック / サスペンド通知後も既存内容をスキップします。画面ロック通知は macOS / Windows のみで、Linux ではロック前に手動で一時停止してください。
- **秘密の自動判定は保証しません。** 対応する macOS アプリの concealed / transient マーカーは可能な範囲で尊重しますが、マーカーがないパスワードや認証コードは通常のテキストと区別できません。
- ローカル保存は任意で、**暗号化されていないプレーンテキスト**です。端末の他のソフトウェア、バックアップ、同じアカウントを使う人が読める可能性があります。詳細は [プライバシーとセキュリティ](docs/PRIVACY.md) を確認してください。
- Linux Wayland では、クリップボード監視・グローバルショートカット・画面右端への位置指定がコンポジターやデスクトップポータルに左右されます。対応しない環境では X11 セッションでの利用を推奨します。トレイが表示されない場合はアプリランチャーから再度 Pupa を起動してください。
- 自動起動、同期、自動更新はありません。更新する場合は新しい配布物を確認して手動で入れ替えます。

## 開発する

必要なもの: Node.js 24、npm、Git。デスクトップ動作の確認には GUI セッションが必要です。依存関係と Electron の取得時、およびパッケージ生成時にはネット接続が必要ですが、完成したアプリの利用には不要です。

```sh
git clone --branch feat/pupa-clipboard-cards https://github.com/kuro0315/Pupa.git
cd Pupa
npm ci
npm start
```

```sh
npm test
npm run typecheck
npm run build
```

`npm start` はレンダラーをビルドして Electron を起動します。`npm run dev` は Vite のブラウザープレビューのみで、OS の機能を動かすコマンドではありません。

ブラウザー用の UI 検証:

```sh
npx playwright install chromium
npm run test:ui
```

ブラウザーで見る UI はプレビューです。OS のクリップボード監視、トレイ、グローバルショートカットは Electron 上でのみ動作します。ブラウザーの成功をネイティブ動作の確認に置き換えないでください。

### インストーラーを生成する

最初に `npm ci` と `npm run build` を実行し、対象 OS 上で次を実行してください。出力は `release/` です。

```sh
# Windows x64: NSIS installer
npm run dist -- --win --x64 --publish never

# macOS: Apple Silicon と Intel の DMG / ZIP
npm run dist -- --mac --arm64 --x64 --publish never

# Linux x64: AppImage / deb
npm run dist -- --linux --x64 --publish never

# 任意: Windows のポータブル版
npm run dist -- --win portable --x64 --publish never

# 同梱ファイルのハッシュ
node scripts/checksums.cjs
```

CI は各 OS のランナーでテスト・型検査・ビルド・パッケージ生成を実行し、Linux では UI 検証も行います。署名鍵なしで動く開発用構成であり、タグ、Release、公開アップロード、自動マージは行いません。

### 構成

```text
electron/                 Electron main / preload と履歴管理
renderer/                 TypeScript + CSS のカード UI
assets/                   オリジナルアイコンとトレイ画像
build/                    インストーラー用画像
scripts/                  アイコン再生成・チェックサム
docs/                     インストール・プライバシー・配布ガイド
electron-builder.yml      OS ごとのパッケージ設定
.github/workflows/        ネイティブ OS のビルド CI
```

Electron 45、Vite 8、TypeScript、electron-builder 26 を使用します。正確なバージョンは `package-lock.json` に固定しています。アイコンは Pupa 専用のオリジナルです。必要に応じて Python 3 と Pillow を用意し、`python scripts/generate-icons.py` で再生成できます。通常のアプリビルドには不要です。

## 技術資料

- [Electron clipboard](https://www.electronjs.org/docs/latest/api/clipboard)
- [Electron globalShortcut / Wayland](https://www.electronjs.org/docs/latest/api/global-shortcut)
- [electron-builder: OS ごとのビルド条件](https://www.electron.build/v26/docs/features/multi-platform-build/)
- [electron-builder: コード署名](https://www.electron.build/v26/docs/features/code-signing/)
- [electron-builder: Linux desktop identity](https://www.electron.build/v26/docs/linux/)
- [GitHub: Artifacts のダウンロード](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
