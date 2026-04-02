#!/bin/bash
# Build WASM and fix import paths

set -e

echo "Building WASM with wasm-pack..."
wasm-pack build --mode no-install --target web --out-dir web-preview/pkg

echo "Fixing import paths..."
# Fix the engine_bridge.js import path in main output
sed -i "s|from './snippets/vzglyd-web-[a-f0-9]*/web-preview/js/engine_bridge.js'|from '../js/engine_bridge.js'|g" web-preview/pkg/vzglyd_web.js

# Fix the vzglyd_web.js import path in snippets
find web-preview/pkg/snippets -name "engine_bridge.js" -exec sed -i \
    "s|from '../pkg/vzglyd_web.js'|from '../../../../../pkg/vzglyd_web.js'|" {} \;

echo "Done! Files are in web-preview/pkg/"
echo ""
echo "Test harness available at: web-preview/test-glb.html"
echo "Open http://localhost:8080/web-preview/test-glb.html to test"
