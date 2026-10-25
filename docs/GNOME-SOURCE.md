# GNOME / Wayland のアプリ名

Pupa の設定で「収集時のアプリを記録」をオンにし、任意の
**Pupa Source App** 拡張機能を有効にすると、新しく収集した履歴に前面アプリ名を付けられます。
GNOME Shell 50 を対象にしています。Pupa 本体も、この連携を含むソースからビルドした版が必要です。
配布済みの 0.2.3 バイナリにはこの変更は含まれていません。

リポジトリのルートで次を実行します（`gnome-extensions` が必要です）。

```sh
gnome-extensions pack extensions/pupa-source@kuro0315.github.io --out-dir /tmp --force
gnome-extensions install --force /tmp/pupa-source@kuro0315.github.io.shell-extension.zip
```

初回インストール後は GNOME からログアウトしてログインし直し、次を実行します。
未保存の作業がある状態でログアウトしないでください。

```sh
gnome-extensions enable pupa-source@kuro0315.github.io
```

新しい Pupa を起動し、別のアプリで新しいテキストをコピーして確認します。
設定はトレイメニューから開けます。古い履歴のコピー元は後から復元できません。
Linux では `/usr/bin/gjs` が必要です。拡張・D-Bus・gjs が使えない場合は「アプリ不明」のまま動作します。

拡張は問い合わせの瞬間の前面アプリ名だけを返します。クリップボード本文、
ウィンドウ名、URLは読みません。Pupa 本体は端末内のアプリ登録情報からアイコンを取得します。履歴・ログ・前回のアプリも保持しません。
画面ロック中・概要画面・前面ウィンドウなし・Pupa 自身は取得対象外です。
同じログインセッションのプロセスは、この名前取得メソッドを呼べます。
コピーと取得の間にアプリを切り替えた場合など、コピー元を保証する情報ではありません。
GNOME 以外の Wayland には対応していません。

複数画面の配置にもこの拡張を使用します。XWayland が返すカーソル位置は、
ネイティブ Wayland アプリ上では古いままの場合があるため、Pupa を開く瞬間に
`GetPointer` で GNOME の現在位置を取得します。位置の監視・保存は行いません。
アプリ名の記録設定とは独立し、画面ロック中は位置を返しません。
拡張が未導入・旧版の場合は XWayland の位置取得へ戻るため、画面選択を保証できません。
拡張更新後に GNOME が旧コードを保持している場合は、ログアウト・ログインが必要です。

無効化・削除:

```sh
gnome-extensions disable pupa-source@kuro0315.github.io
gnome-extensions uninstall pupa-source@kuro0315.github.io
```

実装は [GNOME の WindowTracker API](https://gnome.pages.gitlab.gnome.org/gnome-shell/shell/class.WindowTracker.html)
と [GJS の D-Bus API](https://gjs.guide/guides/gio/dbus.html) を利用します。
実 GNOME 上の拡張読み込み・コピー動作は、合成値のテストとは別に確認が必要です。
