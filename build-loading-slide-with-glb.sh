#!/bin/bash
# Build loading_slide with GLB scene compiled in

set -e

SLIDE_DIR="${1:-/home/rodgerbenham/.openclaw/workspace/lume-loading}"
GLB_PATH="${2:-assets/world.glb}"
OUTPUT_DIR="${3:-/home/rodgerbenham/.openclaw/workspace/lume/target/wasm32-wasip1/release}"

cd "$SLIDE_DIR"

echo "Building loading_slide with GLB scene..."
echo "GLB path: $GLB_PATH"

# The slide needs to be modified to:
# 1. Load the GLB at build time (via build.rs)
# 2. Include the compiled meshes in the spec

# For now, let's just rebuild with the current setup
cargo build --release --target wasm32-wasip1

echo ""
echo "Built: $OUTPUT_DIR/loading_slide.wasm"
echo ""
echo "NOTE: To include GLB scenes, the slide source needs to be modified to:"
echo "  1. Add a build.rs that compiles the GLB"
echo "  2. Include compiled meshes in loading_slide_spec()"
echo "  3. Add DrawSpec entries for each mesh"
