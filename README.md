# VZGLYD Web Host

Browser host for `.vzglyd` bundles.

This repository now exports a runnable page from `web-preview/` where:
- UI shell is JavaScript (`web-preview/app.js`)
- Runtime API is Rust/WASM (`WebHost`)
- Bundle extraction + WASM/sidecar/renderer bridge lives in `web-preview/js/`

## Build

```bash
# one-time
cargo install wasm-pack

# build wasm glue directly into the preview folder
wasm-pack build --target web --out-dir web-preview/pkg
```

## Run

Serve the repository root over HTTP and open `http://localhost:8080/web-preview/`.

```bash
python3 -m http.server 8080
```

## WebHost API

```js
import init, { WebHost } from './pkg/vzglyd_web.js';

await init();
const host = new WebHost(canvas, { networkPolicy: 'any_https' });

await host.loadBundle(bundleBytes, { logLoadSummary: true });
host.frame(performance.now());
const stats = host.stats();
host.teardown();
```

## Notes

- Current browser backend is WebGPU only.
- `.vzglyd` archives are expected to contain `manifest.json` and `slide.wasm`.
- Optional `sidecar.wasm` is loaded when present.
