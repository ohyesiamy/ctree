#!/bin/sh
# ctree installer — downloads the single-file CLI into ~/.local/bin (or $CTREE_BIN_DIR)
#   curl -fsSL https://raw.githubusercontent.com/ohyesiamy/ctree/main/install.sh | sh
set -e

RAW="https://raw.githubusercontent.com/ohyesiamy/ctree/main"
BIN_DIR="${CTREE_BIN_DIR:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "error: ctree requires Node.js >= 18 (https://nodejs.org)" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
curl -fsSL "$RAW/ctree.js" -o "$BIN_DIR/ctree"
chmod +x "$BIN_DIR/ctree"

echo "✓ installed: $BIN_DIR/ctree"
"$BIN_DIR/ctree" --help | head -1 || true

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on your PATH — add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
