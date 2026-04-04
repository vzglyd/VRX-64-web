#!/bin/bash
# Build the web package with working direct JS bridge imports.

set -e

echo "Building WASM with wasm-pack..."
wasm-pack build --mode no-install --target web --out-dir web-preview/pkg

BG_JS="web-preview/pkg/vzglyd_web_bg.js"
if [[ -f "$BG_JS" ]]; then
  perl -0pi -e "s#^import \\{ JsEngineBridge \\} from '\\./snippets/[^']+/web-preview/js/engine_bridge\\.js';#import { JsEngineBridge } from '../js/engine_bridge.js';#m" "$BG_JS"
fi

echo "Done! Files are in web-preview/pkg/"
echo ""
echo "Test harness available at: web-preview/test-glb.html"
echo "Open http://localhost:8080/web-preview/test-glb.html to test"
