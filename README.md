# VZGLYD Web Host

Browser host and repo tools for shared `.vzglyd` slide repositories.

This repository exports runnable pages from `web-preview/`:
- `index.html` previews bundles from a static slide root or a local `.vzglyd` file
- `editor.html` edits and exports `playlist.json` for a static slide root
- `view.html` is the canonical fullscreen player and profiling target
- Runtime API remains Rust/WASM (`WebHost`)
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

To preview a static slide root in the browser, serve that root separately as well:

```bash
python3 -m http.server 8081 --directory /path/to/slides-repo
```

Then paste `http://localhost:8081/` into the preview/editor UI.

GitHub Pages-style hosting works as well. For example, if `playlist.json` lives at
`https://rodgerbenham.github.io/vzglyd/playlist.json`, use
`https://rodgerbenham.github.io/vzglyd/` as the repo base URL.

For the local reference repo already used in this workspace, run:

```bash
./serve-reference-slides.sh
```

That serves the local slide root at `http://localhost:8081/` by default.

## WebHost API

```js
import init, { WebHost } from './pkg/vzglyd_web.js';

await init();
const host = new WebHost(canvas, { networkPolicy: 'any_https' });

await host.loadBundle(bundleBytes, { logLoadSummary: true });
host.frame(performance.now());
const stats = host.stats();
const trace = host.exportTrace();
host.teardown();
```

## Tracing

Tracing is built into the runtime boundaries. To collect a browser trace:

1. Create a session with `VRX-64-tracing/scripts/start_session.py`.
2. Start the collector, or let `start_session.py --start-collector` do it for you.
3. Open `view.html` or `index.html` with:

```text
?trace=1&traceSession=<id>&traceCollector=http://127.0.0.1:43101/api/traces
```

4. Reproduce the issue.
5. Close/reload the page or call `window.vzglydTrace.postTrace()` from DevTools.

`host.stats()` now includes `traceSessionId`, and `host.exportTrace()` / `host.postTrace()` are available from JS.

Slide-local preview pages should redirect into `web-preview/view.html` rather than carrying their own browser runtime shell.

## Shared Repo Contract

The shared slide source is a user-managed directory or repo root served over HTTP with:

- required `playlist.json` at repo root
- repo-root-relative `.vzglyd` bundle paths in `playlist.json`

The full contract and example layout live in [`docs/shared-slide-repo.md`](docs/shared-slide-repo.md).

## Notes

- Current browser backend is WebGPU only.
- `.vzglyd` archives are expected to contain `manifest.json` and `slide.wasm`.
- Optional `sidecar.wasm` is loaded when present.
- Bundles can advertise editor-friendly parameter schemas in `manifest.json -> params.fields`.
