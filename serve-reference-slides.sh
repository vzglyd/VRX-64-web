#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

default_candidates=(
  "$script_dir/../lume/slides"
  "$script_dir/../VRX-64-native/slides"
)

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  ./serve-reference-slides.sh [SLIDES_DIR]

Defaults:
  Serves the first local reference slides repo that contains playlist.json.

Environment overrides:
  VZGLYD_SLIDES_HOST   Host to bind (default: 127.0.0.1)
  VZGLYD_SLIDES_PORT   Port to bind (default: 8081)
EOF
  exit 0
fi

slides_dir="${1:-}"
if [[ -z "$slides_dir" ]]; then
  for candidate in "${default_candidates[@]}"; do
    if [[ -f "$candidate/playlist.json" ]]; then
      slides_dir="$candidate"
      break
    fi
  done
fi

if [[ -z "$slides_dir" ]]; then
  echo "Could not find a reference slides repo with playlist.json." >&2
  echo "Tried:" >&2
  for candidate in "${default_candidates[@]}"; do
    echo "  $candidate" >&2
  done
  echo "Pass a slides repo path explicitly: ./serve-reference-slides.sh /path/to/slides" >&2
  exit 1
fi

slides_dir="$(cd "$slides_dir" && pwd)"

if [[ ! -f "$slides_dir/playlist.json" ]]; then
  echo "Slides repo '$slides_dir' is missing playlist.json." >&2
  exit 1
fi

host="${VZGLYD_SLIDES_HOST:-127.0.0.1}"
port="${VZGLYD_SLIDES_PORT:-8081}"

echo "Serving reference slides from: $slides_dir"
echo "Base URL: http://$host:$port/"
echo "Playlist: http://$host:$port/playlist.json"
echo "CORS: enabled for browser preview/editor fetches"

exec python3 - "$host" "$port" "$slides_dir" <<'PY'
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import sys

host, port, directory = sys.argv[1], int(sys.argv[2]), sys.argv[3]


class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()


handler = partial(CORSRequestHandler, directory=directory)
server = ThreadingHTTPServer((host, port), handler)

try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
PY
