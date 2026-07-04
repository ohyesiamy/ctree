<div align="center">

<img src="docs/assets/logo.svg" width="96" alt="ctree logo">

# ctree

**An editor-style file tree that lives inside your [cmux](https://cmux.io) terminal.**
Click any file — its absolute path lands on your clipboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-e2a656.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/Node-%E2%89%A5%2018-9fc78a.svg)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-8fb3c7.svg)](package.json)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-b49ad2.svg)](#requirements)

English | [日本語](README.ja.md)

<img src="docs/assets/hero-tree.png" width="420" alt="ctree — editor-style file tree in a cmux pane, with a copied-path toast">

</div>

---

## Why

Terminal-native AI coding agents (Claude Code and friends) constantly need **absolute paths** — and a plain shell gives you no way to *see* a directory, let alone grab a path with one click. `ctree` turns any directory into a familiar editor-style sidebar, rendered in a cmux browser pane right next to your agent:

- 🌲 **Editor-style tree** — expand/collapse, file-type icons, indent guides, dark & light themes
- 📋 **Click = copy** — one click puts the file's absolute path on your clipboard, ready to paste into a prompt
- 📝 **Markdown viewer** — GitHub-style rendering with live reload
- 🎨 **Code viewer** — syntax highlighting for 190+ languages, word wrap always on
- 🖼 **Image viewer** — PNG / JPEG / SVG / WebP / GIF on a checkerboard, PDF via native rendering
- 🔄 **Live updates** — file changes stream to the tree over SSE, no manual refresh
- 🙈 **Sensible filtering** — respects `.gitignore`, hides `node_modules` / `.git`, dotfiles behind a toggle
- ♻️ **Idempotent** — run it as many times as you like; server and pane are reused, never duplicated
- 📦 **Zero dependencies** — one Node script, no build step, no node_modules

## Screenshots

| Code viewer | Markdown viewer |
|:---:|:---:|
| <img src="docs/assets/code-viewer.png" width="380" alt="Code viewer with syntax highlighting and word wrap"> | <img src="docs/assets/markdown-viewer.png" width="380" alt="Markdown viewer with tables and blockquotes"> |

| Image viewer | Narrow pane (240 px) |
|:---:|:---:|
| <img src="docs/assets/image-viewer.png" width="380" alt="Image viewer with checkerboard background and dimensions"> | <img src="docs/assets/narrow-pane.png" width="200" alt="The tree stays readable in a 240px-wide pane"> |

## Installation

### One-liner (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/ohyesiamy/ctree/main/install.sh | sh
```

Installs a single file to `~/.local/bin/ctree`. Set `CTREE_BIN_DIR` to change the destination.

### npm

```sh
npm install -g github:ohyesiamy/ctree
```

### Manual

```sh
git clone https://github.com/ohyesiamy/ctree.git
ln -sf "$(pwd)/ctree/ctree.js" ~/.local/bin/ctree
```

### Requirements

- macOS (`pbcopy` is used for the clipboard)
- Node.js ≥ 18
- [cmux](https://cmux.io) — optional; without it, `ctree` prints a URL you can open in any browser

## Usage

```sh
ctree [dir]        # open the tree for a directory (default: cwd) in a cmux pane
ctree --if-cmux    # start only when running inside cmux (for hooks)
ctree --no-open    # start the server and print the URL, don't open a pane
ctree --help
```

In the tree:

| Action | Result |
|---|---|
| Click a row | Copy the absolute path (toast confirms it) |
| Click **▶** | Expand / collapse a folder |
| Click the icon at the row's right edge | Preview: markdown / image / code viewer |
| 👁 (header) | Toggle dotfiles |

## Claude Code integration

Add a `SessionStart` hook to `~/.claude/settings.json` and the tree of your working directory opens automatically whenever a Claude Code session starts inside cmux:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.local/bin/ctree\" --if-cmux 2>/dev/null || true",
            "timeout": 15,
            "async": true
          }
        ]
      }
    ]
  }
}
```

Outside cmux the hook exits instantly and does nothing.

## How it works

```
ctree <dir>
  │  resolves the absolute root
  │  reuses a running server (~/.cache/ctree/<hash>.json) or spawns one
  ▼
local HTTP server (127.0.0.1, random port, one per root)
  ├─ GET  /            tree UI (single HTML, inline CSS/JS)
  ├─ GET  /api/tree    one directory level per request — lazy, fast on huge repos
  ├─ POST /api/copy    pipes the path to pbcopy (server-side: webview clipboard is unreliable)
  ├─ GET  /api/events  SSE; fs.watch on expanded directories pushes changes
  ├─ GET  /md /code /img /raw   viewers
  ▼
cmux browser pane (`cmux browser open`), reused across restarts
```

Design notes:

- **The server outlives the CLI.** State (pid + port) is cached per root; every later `ctree` call reuses it. When the server restarts on a new port, the old pane is found by its title and navigated instead of opening a duplicate.
- **Clipboard is server-side.** WebKit webviews restrict `navigator.clipboard`; piping to `pbcopy` always works.
- **Syntax highlighting** delegates the many-languages problem to [highlight.js](https://highlightjs.org) loaded from a CDN at view time — 190+ languages with zero bundled bytes. Offline? The viewer gracefully degrades to plain text, and word wrap still applies. Token colors are defined by ctree's own theme, so light/dark always match.
- **Native first, fallback second.** For markdown, ctree first tries cmux's built-in viewer (`cmux markdown open`). A long-lived server is an orphaned process, and cmux's socket auth rejects those — so when that fails, the built-in viewer takes over automatically.

## Configuration

| Environment variable | Effect |
|---|---|
| `CTREE_DEBUG=1` | Trace every cmux CLI invocation to stderr |
| `CTREE_COPY_CMD` | Clipboard command (default `pbcopy`) |
| `CTREE_CMUX_BIN` | cmux binary (default `cmux` on PATH) |
| `CTREE_BIN_DIR` | Install destination for `install.sh` (default `~/.local/bin`) |

## FAQ

**Does it work without cmux?**
Yes. `ctree --no-open` prints a URL; open it in any browser. Everything works except the pane management.

**Is anything sent over the network?**
The server binds to `127.0.0.1` only. The single exception is the code viewer fetching highlight.js from jsDelivr; when it can't, code renders as plain text.

**Why doesn't the markdown button open cmux's native viewer?**
cmux's socket rejects commands from orphaned processes (a daemonized server is one). ctree detects this and falls back to its built-in viewer — same content, live reload included.

**Huge repository?**
The tree lists one level per request and never walks the whole tree. Directories over 2,000 entries are truncated with an explicit "…N more" row.

## Development

```sh
git clone https://github.com/ohyesiamy/ctree.git && cd ctree
node --test          # run the test suite
CTREE_DEBUG=1 ./ctree.js .   # run from source with tracing
```

The whole program is one file — `ctree.js` — organized as: gitignore matcher → fs listing → HTTP server → markdown renderer → cmux integration → CLI → UI templates.

## License

[MIT](LICENSE) © 2026 ohyesiamy
