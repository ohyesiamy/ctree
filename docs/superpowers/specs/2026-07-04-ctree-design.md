# ctree — cmux 用ディレクトリツリービューア 設計書

日付: 2026-07-04 / ステータス: 承認済み

## 目的

cmux (macOS ターミナルアプリ、改造不可) の中で、特定ディレクトリをエディタのサイドバー風の木構造で表示したい。
Claude Code 使用時にファイルの絶対パスが分からず開けない問題を解決する。

- **クリックでそのファイル/ディレクトリの絶対パスをクリップボードへコピー** (唯一のクリック挙動)
- 起動は「コマンド一発」と「Claude Code の SessionStart hook からの自動起動」の両方

## アプローチ (承認済み: 案A)

依存ゼロの単一 Node スクリプト `ctree` がローカル HTTP サーバを起動し、
`cmux browser open http://127.0.0.1:<port>` で cmux のブラウザペインにツリー UI を表示する。

- 実体: `~/workspace/ctree/ctree` (Node v26、外部依存なし、単一ファイル)
- インストール: `~/.local/bin/ctree` へ symlink

## 起動・ライフサイクル

- `ctree [dir]` — dir 省略時はカレントディレクトリ。絶対パスに解決
- ポートは自動割当 (listen port 0)。127.0.0.1 のみ bind
- ルートごとに `~/.cache/ctree/<sha256(root)先頭16>.json` に `{pid, port, root}` を記録。
  生存確認 (pid alive + `/api/ping` 応答) できれば再利用し、新プロセスは起動しない
- 同一 cmux workspace に同 URL のブラウザ surface が既にあればペインを新規に開かない
  (cmux CLI の `tree` / `browser url` で確認)
- `--if-cmux`: 環境変数 `CMUX_SOCKET_PATH` が無ければ exit 0 (hook 用)
- cmux CLI が使えない場合は URL を stdout に出して継続 (通常ブラウザで開ける)
- Claude Code hook: `~/.claude/settings.json` の SessionStart に `ctree --if-cmux` を追加
  (hook はセッション cwd で実行されるため引数不要)

## サーバ API

| エンドポイント | 役割 |
|---|---|
| `GET /` | ツリー UI (HTML/CSS/JS すべてインライン、外部リソースなし) |
| `GET /api/ping` | 生存確認 |
| `GET /api/tree?path=` | 1 階層分のエントリ一覧 (遅延読み込み)。root 外のパスは 403 |
| `POST /api/copy` | `{path}` を macOS `pbcopy` でコピー (webview の clipboard 制限回避) |
| `GET /api/events` | SSE。展開中ディレクトリのみ `fs.watch`、変更で該当階層の再取得を通知 |

## 除外・表示ルール

- `.git`, `node_modules` は常時除外
- ルートの `.gitignore` を簡易解釈して除外 (ネストした .gitignore は対象外で良い)
- 隠しファイル (dotfiles) はヘッダのトグルで表示切替 (既定: 非表示)
- ソート: ディレクトリ先行、それぞれ名前順 (locale 順)

## UI 要件

- エディタサイドバー風: 展開/折りたたみ、種別アイコン、インデントガイド、ダークテーマ基調
  (ライト/ダーク両対応: `prefers-color-scheme`)
- クリック → 絶対パスコピー + 「コピーしました」トースト
- **HTML 内にターミナルでの使い方 (usage) セクションを表示する**
  (`ctree [dir]`、`--if-cmux`、hook 設定例、再利用の挙動)
- **狭いペイン幅 (200〜320px 程度) への十分な配慮**:
  - 横スクロールをページ全体に発生させない。長いファイル名は行内で省略 (ellipsis) しつつ
    title 属性等でフルネーム確認可能に
  - usage セクション等の日本語文は文節改行 4 層ルール (CSS `word-break: auto-phrase` +
    keep-all 単位 + BudouX 相当 + wbr) を適用
  - コードスニペットは `overflow-x: auto` のコンテナ内でのみスクロール
- レイアウトは Flexbox のみ (CSS Grid 禁止ルール遵守)
- 文字サイズ: UI ラベル 13px 以上、本文 14px 以上、CJK weight 500 以上 (タイポグラフィルール遵守)
- WebGPU 演出は不採用 (実用パネルであり、演出はノイズになるため。ルールに従い明示的に判断)

## エラー処理

- 権限のないディレクトリ: 展開時にその行へエラー表示 (アプリは落とさない)
- pbcopy 失敗: トーストでエラー通知
- ポート/ソケットエラー: stderr にメッセージ、exit 1

## テスト

- `node --test`: 階層列挙、gitignore 除外、root 外パスの 403、copy (pbcopy をモック)
- 表示は cmux `browser open` + `browser snapshot` / `browser screenshot` で実機確認
  (1280 / 768 / 375 相当 + 狭ペイン 240px で改行・省略の目視確認)
