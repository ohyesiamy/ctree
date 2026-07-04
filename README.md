# ctree

cmux のブラウザペインに、ディレクトリをエディタのサイドバー風ツリーで表示する CLI。
依存ゼロの単一 Node スクリプト。

## 何ができるか

- **行クリックでそのファイル/フォルダの絶対パスをクリップボードへコピー**
  (Claude Code のプロンプトにすぐ貼れる)
- フォルダの展開/折りたたみ、隠しファイル表示切替、`.gitignore` 尊重
- ファイル変更のライブ反映 (fs 監視 + SSE)
- `.md` は本のアイコンから **markdown ビューア**で閲覧
  (cmux ネイティブビューアを試し、開けない場合は内蔵ビューアへ自動フォールバック。どちらもライブ更新)
- 同じディレクトリに対してはサーバ・ペインを再利用 (何度実行してもペインは増えない)

## インストール

```sh
ln -sf "$(pwd)/ctree.js" ~/.local/bin/ctree
```

要件: Node.js / macOS (パスコピーに `pbcopy` を使用) / cmux (なくても URL 表示で動作)

## 使い方

```sh
ctree [dir]        # 指定ディレクトリ (省略時はカレント) のツリーを cmux ペインで開く
ctree --if-cmux    # cmux 内のときだけ起動 (Claude Code hook 用)
ctree --no-open    # ペインを開かず URL だけ表示
```

### Claude Code hook (セッション開始時に自動で開く)

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "ctree --if-cmux" } ] }
    ]
  }
}
```

## 実装メモ

- ルートごとにローカル HTTP サーバを常駐 (`~/.cache/ctree/<hash>.json` に pid/port を記録して再利用)
- パスコピーは webview のクリップボード制限を避けるためサーバ側で `pbcopy` を実行
- **常駐サーバから cmux CLI は呼べない** (親プロセス終了後の孤児プロセスは
  cmux の socket 認証に失敗する)。そのため markdown のネイティブビューア起動が
  失敗した場合は内蔵ビューア (`/md?path=`) に自動フォールバックする
- デバッグ: `CTREE_DEBUG=1 ctree ...` で cmux CLI 呼び出しのトレースを表示

## テスト

```sh
node --test
```
