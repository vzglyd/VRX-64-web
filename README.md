# VZGLYD Web Host

Web (WebGPU + WASM) host implementation for the VZGLYD display engine.

## Overview

This crate integrates the platform-agnostic `vzglyd-kernel` with:
- **WebGPU** (via web-sys) for GPU rendering
- **Browser WASM** for slide instantiation
- **fetch()** for asset loading
- **requestAnimationFrame** for the render loop

## Building

```bash
# Install wasm-pack if not already installed
cargo install wasm-pack

# Build for web
wasm-pack build --target web --out-dir ../vzglyd.github.io/pkg
```

## Usage

```javascript
// In your HTML/JavaScript
import init, { WebHost } from './pkg/vzglyd_web.js';

async function start() {
    await init();
    
    const canvas = document.getElementById('canvas');
    const gpu = navigator.gpu;
    const adapter = await gpu.requestAdapter();
    const device = await adapter.requestDevice();
    
    const host = new WebHost(canvas, device);
    
    function frame(timestamp) {
        host.frame(timestamp);
        requestAnimationFrame(frame);
    }
    
    requestAnimationFrame(frame);
}

start();
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Web Host                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ HTML Canvas │  │ Browser WASM │  │ fetch()          │   │
│  │             │  │              │  │ asset loading    │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ WebGPU      │  │ WebHost      │  │ RenderCommand    │   │
│  │ (web-sys)   │  │ : Host       │  │ → WebGPU exec    │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ implements Host trait
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                  VZGLYD Kernel                              │
│  - Engine state machine                                     │
│  - Slide scheduling                                         │
│  - Transition logic                                         │
│  - RenderCommand generation                                 │
└─────────────────────────────────────────────────────────────┘
```

## Browser Requirements

- Chrome 113+ with WebGPU enabled
- Edge 113+ with WebGPU enabled
- Safari 18+ with WebGPU enabled

## License

MIT OR Apache-2.0
