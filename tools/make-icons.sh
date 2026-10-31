#!/usr/bin/env bash
# Перерисовывает PNG-иконки из SVG-исходников в tools/ (нужен Google Chrome или Chromium).
# Запуск: bash tools/make-icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
render() { # svg size out
  cat > "$TMP/page.html" <<HTML
<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:$2px;height:$2px}</style></head>
<body><img src="file://$PWD/$1"></body></html>
HTML
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$2,$2" --screenshot="$PWD/$3" "file://$TMP/page.html" >/dev/null 2>&1
  echo "  $3 (${2}×${2})"
}
render tools/icon.svg 192 icons/icon-192.png
render tools/icon.svg 512 icons/icon-512.png
render tools/icon-maskable.svg 512 icons/icon-maskable-512.png
render tools/icon-apple.svg 180 icons/apple-touch-icon.png
cp tools/icon.svg icons/favicon.svg
