#!/bin/bash
# Build the web package with working direct JS bridge imports.

set -e

echo "Building WASM with wasm-pack..."
wasm-pack build --mode no-install --target web --out-dir web-preview/pkg

echo "Done! Files are in web-preview/pkg/"
echo ""
echo "Test harness available at: web-preview/test-glb.html"
echo "Open http://localhost:8080/web-preview/test-glb.html to test"
