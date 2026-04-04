import { decodeSlideSpec } from './postcard.js';
import { createFrameStats, recordFrameStats } from './frame_stats.js';
import { VzglydRenderer } from './renderer.js';
import { createTraceRecorder } from './trace_recorder.js';
import { VzglydWasmHost } from './wasm-host.js';
import { asUint8Array, unpackBundle } from './bundle_manifest.js';
import { loadGlbScene, encodeMeshAsset, encodeSceneAnchorSet } from '../pkg/vzglyd_web.js';

const WIRE_VERSION = 1;
const TEXT_ENCODER = new TextEncoder();

function encodeRuntimeParams(params) {
  if (params == null) {
    return null;
  }
  return TEXT_ENCODER.encode(JSON.stringify(params));
}

function nowMs() {
  return performance.now();
}

function measureCall(fn) {
  const startMs = nowMs();
  const result = fn();
  return {
    result,
    durationMs: nowMs() - startMs,
  };
}

function toWorldLightingSpec(compiledLighting, fallbackLighting = null) {
  if (!compiledLighting?.directional_light && !fallbackLighting) return null;

  return {
    ambient_color: fallbackLighting?.ambient_color ?? [1, 1, 1],
    ambient_intensity: fallbackLighting?.ambient_intensity ?? 0.22,
    directional_light: compiledLighting?.directional_light
      ? {
          direction: compiledLighting.directional_light.direction,
          color: compiledLighting.directional_light.color,
          intensity: compiledLighting.directional_light.intensity,
        }
      : (fallbackLighting?.directional_light ?? null),
  };
}

function toWorldStaticMesh(mesh) {
  return {
    label: mesh.label || mesh.id,
    vertices: mesh.vertices.map((vertex) => ({
      position: vertex.position,
      normal: vertex.normal,
      color: vertex.color,
      mode: vertex.mode,
    })),
    indices: mesh.indices,
  };
}

function toWorldDraw(mesh, meshIndex) {
  return {
    label: mesh.label || mesh.id,
    source: { kind: 'Static', index: meshIndex },
    pipeline: mesh.pipeline === 'transparent' ? 'Transparent' : 'Opaque',
    index_range: { start: 0, end: mesh.indices.length },
  };
}

function attachHybridWorldBackground(spec, compiledMeshes, compiledCameraPath, compiledLighting) {
  const static_meshes = compiledMeshes.map(toWorldStaticMesh);
  const draws = compiledMeshes.map((mesh, index) => toWorldDraw(mesh, index));

  spec.background_world = {
    name: `${spec.name}_background_world`,
    scene_space: 'World3D',
    camera_path: compiledCameraPath ?? spec.camera_path,
    lighting: toWorldLightingSpec(compiledLighting, spec.lighting),
    shaders: null,
    overlay: null,
    font: null,
    textures_used: 0,
    textures: [],
    static_meshes,
    dynamic_meshes: [],
    draws,
  };
}

function requiresAuthoredSceneCompilation(manifest) {
  return Array.isArray(manifest?.assets?.scenes) && manifest.assets.scenes.length > 0;
}

class SidecarWorkerRuntime {
  constructor(options = {}) {
    this._channelState = options.channelState;
    this._networkPolicy = options.networkPolicy ?? 'any_https';
    this._endpointMap = options.endpointMap ?? {};
    this._onTrace = options.onTrace ?? null;
    this._worker = null;
  }

  async start(wasmBytes, paramsBytes = null) {
    if (typeof Worker !== 'function') {
      throw new Error('browser sidecars require Worker support');
    }

    const worker = new Worker(new URL('./sidecar-worker.js', import.meta.url), {
      type: 'module',
    });
    this._worker = worker;

    const ready = new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };

      const onMessage = (event) => {
        const { data } = event;
        if (data?.type === 'ready') {
          cleanup();
          resolve();
          return;
        }
        if (data?.type === 'error') {
          cleanup();
          reject(new Error(data.message));
          return;
        }
        this._handleMessage(data);
      };

      const onError = (event) => {
        cleanup();
        reject(event.error ?? new Error(event.message));
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
    });

    worker.addEventListener('message', (event) => {
      this._handleMessage(event.data);
    });

    const message = {
      type: 'init',
      wasmBytes,
      paramsBytes,
      networkPolicy: this._networkPolicy,
      endpointMap: this._endpointMap,
    };
    const transfer = [wasmBytes.buffer];
    if (paramsBytes) {
      transfer.push(paramsBytes.buffer);
    }

    worker.postMessage(message, transfer);

    await ready;
  }

  _handleMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'channel_push' && data.bytes) {
      this._channelState.latest = data.bytes;
      this._channelState.dirty = true;
      return;
    }
    if (data.type === 'log') {
      console.log('[vzglyd][sidecar]', data.message);
      return;
    }
    if (data.type === 'trace' && data.event) {
      this._onTrace?.(data.event);
      return;
    }
    if (data.type === 'error') {
      console.error('[vzglyd][sidecar]', data.message);
    }
  }

  terminate() {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }
}

export class EngineBridge {
  constructor(canvas, hostConfig = null) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('EngineBridge requires an HTMLCanvasElement');
    }

    this._canvas = canvas;
    this._hostConfig = hostConfig ?? {};

    this._renderer = null;
    this._slideHost = null;
    this._sidecarHost = null;

    this._channelState = {
      latest: null,
      dirty: false,
      active: false,
    };

    this._loaded = false;
    this._lastTimestampMs = null;
    this._slideName = '';
    this._manifestName = '';
    this._lastError = null;
    this._gpuState = null;
    this._compiledSceneMeshes = [];
    this._compiledSceneCameraPath = null;
    this._compiledSceneLighting = null;
    this._frameStats = createFrameStats();
    this._traceRecorder = this._hostConfig?.trace?.enabled
      ? createTraceRecorder({
          enabled: true,
          hostKind: 'web',
          label: this._hostConfig.trace.label ?? 'web-session',
          sessionId: this._hostConfig.trace.sessionId,
          autoStart: this._hostConfig.trace.autoStart === true,
        })
      : null;
    this._traceRecorder?.bindLongTasks('web.main');
  }

  _relayWorkerTrace(event) {
    if (!this._traceRecorder || !event) return;

    if (event.kind === 'span_start') {
      this._traceRecorder.beginSpanWithId(
        event.spanId,
        event.thread,
        event.category,
        event.name,
        event.args ?? {},
        event.atMs,
      );
      return;
    }

    if (event.kind === 'span_end') {
      this._traceRecorder.endSpan(event.spanId, event.args ?? {}, event.atMs);
      return;
    }

    if (event.kind === 'instant') {
      this._traceRecorder.instant(
        event.thread,
        event.category,
        event.name,
        event.args ?? {},
        event.atMs,
      );
      return;
    }

    if (event.kind === 'complete') {
      this._traceRecorder.completeAt(
        event.thread,
        event.category,
        event.name,
        event.startMs,
        event.durationMs,
        event.args ?? {},
      );
    }
  }

  async loadBundle(bundleBytes, runtimeOptions = null) {
    this.teardown();
    const loadStartedMs = nowMs();

    try {
      const bytes = asUint8Array(bundleBytes);
      const pkg = unpackBundle(bytes);
      const traceMetadata = {
        bundle_bytes: bytes.length,
        manifest_name: pkg.manifest?.name ?? '',
        manifest_version: pkg.manifest?.version ?? '',
        has_sidecar: Boolean(pkg.sidecarWasm),
      };
      if (this._traceRecorder) {
        for (const [key, value] of Object.entries(traceMetadata)) {
          if (value !== '' && value != null) {
            this._traceRecorder.setMetadata(key, value);
          }
        }
      }

      const meshAssets = new Map(pkg.miscAssets);
      const sceneMetadata = new Map(pkg.miscAssets);

      // Handle authored scene compilation if needed
      if (requiresAuthoredSceneCompilation(pkg.manifest)) {
        const compileStartedMs = nowMs();
        await this.compileAuthoredScenes(pkg.manifest, pkg.miscAssets, meshAssets, sceneMetadata);
        this._traceRecorder?.completeAt(
          'web.main',
          'bundle',
          'compile_authored_scenes',
          compileStartedMs,
          nowMs() - compileStartedMs,
          {
            scene_count: pkg.manifest.assets.scenes.length,
            compiled_meshes: this._compiledSceneMeshes.length,
          },
        );
      }

      const slideHost = new VzglydWasmHost({
        channelState: this._channelState,
        meshAssets,
        sceneMetadata,
        traceRecorder: this._traceRecorder,
        traceThread: `slide:${pkg.manifest?.name ?? 'guest'}`,
        traceCategory: 'guest.slide',
      });
      const paramsBytes = encodeRuntimeParams(runtimeOptions?.params);
      
      // Pass compiled meshes to slideHost for potential use
      slideHost._compiledSceneMeshes = this._compiledSceneMeshes || [];

      const instantiateStartedMs = nowMs();
      const slideModule = await WebAssembly.instantiate(pkg.slideWasm, slideHost.buildImports());
      this._traceRecorder?.completeAt(
        'web.main',
        'bundle',
        'instantiate_slide',
        instantiateStartedMs,
        nowMs() - instantiateStartedMs,
        {
          wasm_bytes: pkg.slideWasm.length,
        },
      );

      const runtimeInitStartedMs = nowMs();
      slideHost.setInstance(slideModule.instance);
      slideHost.runStart();
      slideHost.configureParams(paramsBytes);
      this._traceRecorder?.completeAt(
        'web.main',
        'bundle',
        'configure_slide',
        runtimeInitStartedMs,
        nowMs() - runtimeInitStartedMs,
        {
          has_params: Boolean(paramsBytes),
        },
      );

      // Note: We no longer patch the spec in WASM memory (postcard is variable-length).
      // Instead, we'll modify the decoded spec object below.
      console.log('[vzglyd] Compiled meshes ready:', slideHost._compiledSceneMeshes.length);

      const initStartedMs = nowMs();
      slideHost.runInit();
      this._traceRecorder?.completeAt(
        'web.main',
        'bundle',
        'vzglyd_init',
        initStartedMs,
        nowMs() - initStartedMs,
      );

      const specReadStartedMs = nowMs();
      const specWire = slideHost.readSpecBytes();
      if (specWire[0] !== WIRE_VERSION) {
        throw new Error(`unsupported slide wire version ${specWire[0]} (expected ${WIRE_VERSION})`);
      }

      let spec = decodeSlideSpec(specWire.slice(1));
      this._traceRecorder?.completeAt(
        'web.main',
        'bundle',
        'decode_spec',
        specReadStartedMs,
        nowMs() - specReadStartedMs,
        {
          spec_bytes: specWire.length,
          scene_space: spec.scene_space,
        },
      );
      
      if (this._compiledSceneMeshes && this._compiledSceneMeshes.length > 0) {
        if (spec.scene_space === 'Screen2D') {
          console.log('[vzglyd] Attaching', this._compiledSceneMeshes.length, 'compiled meshes as World3D background');
          attachHybridWorldBackground(
            spec,
            this._compiledSceneMeshes,
            this._compiledSceneCameraPath,
            this._compiledSceneLighting,
          );
        } else {
          console.log('[vzglyd] Adding', this._compiledSceneMeshes.length, 'compiled meshes to spec');

          for (const mesh of this._compiledSceneMeshes) {
            spec.static_meshes.push(toWorldStaticMesh(mesh));

            const meshIndex = spec.static_meshes.length - 1;
            spec.draws.push(toWorldDraw(mesh, meshIndex));
          }

          console.log('[vzglyd] Spec now has', spec.static_meshes.length, 'meshes and', spec.draws.length, 'draws');
        }
      }
      
      // Apply camera path from GLB if available
      if (this._compiledSceneCameraPath) {
        console.log('[vzglyd] Applying camera path from GLB:', this._compiledSceneCameraPath);
        spec.camera_path = this._compiledSceneCameraPath;
      }

      if (this._compiledSceneLighting) {
        spec.lighting = toWorldLightingSpec(this._compiledSceneLighting, spec.lighting);
      }
      
      const rendererInitStartedMs = nowMs();
      const renderer = new VzglydRenderer(this._canvas, spec, this._gpuState);
      await renderer.init();
      this._gpuState = renderer.gpuState();
      this._frameStats = createFrameStats();
      this._traceRecorder?.completeAt(
        'web.main',
        'bundle',
        'renderer_init',
        rendererInitStartedMs,
        nowMs() - rendererInitStartedMs,
        {
          canvas_width: this._canvas.width,
          canvas_height: this._canvas.height,
          dpr: globalThis.devicePixelRatio ?? 1,
        },
      );

      const initialOverlayStartedMs = nowMs();
      const initialOverlayApplied = renderer.applyOverlayBytes(slideHost.readOverlayBytes());
      this._traceRecorder?.completeAt(
        'web.main',
        'runtime',
        'initial_overlay_upload',
        initialOverlayStartedMs,
        nowMs() - initialOverlayStartedMs,
        {
          uploaded: initialOverlayApplied,
        },
      );
      const initialDynamicStartedMs = nowMs();
      const initialDynamicApplied = renderer.applyDynamicMeshBytes(slideHost.readDynamicMeshBytes());
      this._traceRecorder?.completeAt(
        'web.main',
        'runtime',
        'initial_dynamic_upload',
        initialDynamicStartedMs,
        nowMs() - initialDynamicStartedMs,
        {
          uploaded: initialDynamicApplied,
        },
      );

      let sidecarHost = null;
      if (pkg.sidecarWasm) {
        const sidecarStartedMs = nowMs();
        sidecarHost = new SidecarWorkerRuntime({
          channelState: this._channelState,
          networkPolicy: this._hostConfig?.networkPolicy ?? 'any_https',
          endpointMap: this._hostConfig?.sidecarEndpoints ?? {},
          onTrace: (event) => this._relayWorkerTrace(event),
        });
        this._channelState.active = true;
        await sidecarHost.start(pkg.sidecarWasm.slice(), paramsBytes ? paramsBytes.slice() : null);
        this._traceRecorder?.completeAt(
          'web.main',
          'bundle',
          'start_sidecar',
          sidecarStartedMs,
          nowMs() - sidecarStartedMs,
          {
            wasm_bytes: pkg.sidecarWasm.length,
          },
        );
      }

      this._renderer = renderer;
      this._slideHost = slideHost;
      this._sidecarHost = sidecarHost;

      this._manifestName = pkg.manifest?.name ?? '';
      this._slideName = spec?.name ?? '';
      this._lastTimestampMs = null;
      this._lastError = null;
      this._loaded = true;
      this._traceRecorder?.setMetadata('slide_name', this._slideName);
      this._traceRecorder?.instant('web.main', 'display', 'canvas_state', {
        css_width: Math.round(this._canvas.getBoundingClientRect().width),
        css_height: Math.round(this._canvas.getBoundingClientRect().height),
        backing_width: this._canvas.width,
        backing_height: this._canvas.height,
        dpr: globalThis.devicePixelRatio ?? 1,
      });
      this._traceRecorder?.completeAt(
        'web.main',
        'bundle',
        'load_bundle',
        loadStartedMs,
        nowMs() - loadStartedMs,
        {
          manifest: this._manifestName,
          slide: this._slideName,
          sidecar: Boolean(pkg.sidecarWasm),
        },
      );

      if (runtimeOptions?.logLoadSummary) {
        console.info('[vzglyd] loaded bundle', {
          manifest: this._manifestName,
          slide: this._slideName,
          sidecar: Boolean(pkg.sidecarWasm),
        });
      }
    } catch (error) {
      this._lastError = error instanceof Error ? error.message : String(error);
      this._traceRecorder?.completeAt(
        'web.main',
        'bundle',
        'load_bundle',
        loadStartedMs,
        nowMs() - loadStartedMs,
        {
          error: this._lastError,
        },
      );
      this.teardown();
      throw error;
    }
  }

  /**
   * Compile authored GLB scenes into mesh assets and anchor sets.
   */
  async compileAuthoredScenes(manifest, miscAssets, meshAssets, sceneMetadata) {
    const scenes = manifest.assets.scenes || [];
    this._compiledSceneMeshes = this._compiledSceneMeshes || [];

    for (const sceneRef of scenes) {
      const scenePath = sceneRef.path;

      // Find the GLB bytes from miscAssets
      let glbBytes = miscAssets.get(scenePath);
      if (!glbBytes) {
        // Try by basename
        const baseName = scenePath.split('/').pop();
        for (const [path, bytes] of miscAssets) {
          if (path.endsWith(baseName)) {
            glbBytes = bytes;
            break;
          }
        }
      }

      if (!glbBytes) {
        throw new Error(`Scene asset not found: ${scenePath}`);
      }

      // Build scene reference JSON
      const sceneRefJson = JSON.stringify({
        path: scenePath,
        id: sceneRef.id,
        label: sceneRef.label,
        entryCamera: sceneRef.entryCamera,
        compileProfile: sceneRef.compileProfile,
      });

      // Load and compile the GLB scene using Rust
      const compiledSceneJson = await loadGlbScene(glbBytes, scenePath, sceneRefJson);
      const compiledScene = JSON.parse(compiledSceneJson);

      // Encode each mesh as a MeshAsset
      for (const mesh of compiledScene.meshes) {
        const meshJson = JSON.stringify(mesh);
        const encodedMesh = encodeMeshAsset(meshJson);
        const meshKey = mesh.id || mesh.label || scenePath;
        console.log('[vzglyd] storing mesh asset with key:', meshKey);
        meshAssets.set(meshKey, new Uint8Array(encodedMesh));

        // Store mesh data for spec integration
        this._compiledSceneMeshes.push({
          id: mesh.id,
          label: mesh.label,
          vertices: mesh.vertices,
          indices: mesh.indices,
          pipeline: mesh.pipeline,
        });
      }

      // Store camera_path from compiled scene (will be applied to spec later)
      if (compiledScene.camera_path) {
        this._compiledSceneCameraPath = compiledScene.camera_path;
        console.log('[vzglyd] Found camera path with', compiledScene.camera_path.keyframes.length, 'keyframes');
      }

      if (compiledScene.lighting) {
        this._compiledSceneLighting = compiledScene.lighting;
        console.log('[vzglyd] Found compiled scene lighting');
      }

      // Encode the scene anchor set
      const encodedAnchors = encodeSceneAnchorSet(compiledSceneJson);
      const anchorKey = compiledScene.id;
      console.log('[vzglyd] storing scene metadata with key:', anchorKey);
      sceneMetadata.set(anchorKey, new Uint8Array(encodedAnchors));

      console.log(`Compiled scene: ${compiledScene.id} with ${compiledScene.meshes.length} meshes and ${compiledScene.anchors.length} anchors`);
    }
    
    console.log('[vzglyd] Total compiled meshes for spec patching:', this._compiledSceneMeshes.length);
  }

  frame(timestampMs) {
    if (!this._loaded || !this._slideHost || !this._renderer) return;
    const frameStartedMs = nowMs();

    const dt = this._lastTimestampMs == null
      ? 1 / 60
      : Math.max(0, Math.min(0.25, (timestampMs - this._lastTimestampMs) / 1000));
    this._lastTimestampMs = timestampMs;

    const updateStartedMs = nowMs();
    const updateSample = measureCall(() => this._slideHost.update(dt));
    const runtimeStatus = updateSample.result;
    this._traceRecorder?.completeAt(
      'web.main',
      'runtime',
      'vzglyd_update',
      updateStartedMs,
      updateSample.durationMs,
      {
        dt_ms: (dt * 1000).toFixed(3),
        status_code: runtimeStatus,
      },
    );
    let overlayUploadMs = 0;
    let dynamicUploadMs = 0;
    let overlayUploaded = false;
    let dynamicUploaded = false;

    if (runtimeStatus !== 0) {
      const overlayStartedMs = nowMs();
      const overlaySample = measureCall(() =>
        this._renderer.applyOverlayBytes(this._slideHost.readOverlayBytes()),
      );
      overlayUploadMs = overlaySample.durationMs;
      overlayUploaded = overlaySample.result;
      this._traceRecorder?.completeAt(
        'web.main',
        'runtime',
        'overlay_upload',
        overlayStartedMs,
        overlayUploadMs,
        {
          uploaded: overlayUploaded,
          status_code: runtimeStatus,
        },
      );

      const dynamicStartedMs = nowMs();
      const dynamicSample = measureCall(() =>
        this._renderer.applyDynamicMeshBytes(this._slideHost.readDynamicMeshBytes()),
      );
      dynamicUploadMs = dynamicSample.durationMs;
      dynamicUploaded = dynamicSample.result;
      this._traceRecorder?.completeAt(
        'web.main',
        'runtime',
        'dynamic_upload',
        dynamicStartedMs,
        dynamicUploadMs,
        {
          uploaded: dynamicUploaded,
          status_code: runtimeStatus,
        },
      );
    }

    const renderStartedMs = nowMs();
    const renderSample = measureCall(() => this._renderer.renderFrame(dt));
    this._traceRecorder?.completeAt(
      'web.main',
      'render',
      'render_frame',
      renderStartedMs,
      renderSample.durationMs,
      {
        dt_ms: (dt * 1000).toFixed(3),
      },
    );
    recordFrameStats(this._frameStats, {
      updateMs: updateSample.durationMs,
      overlayUploadMs,
      dynamicUploadMs,
      renderMs: renderSample.durationMs,
      overlayUploaded,
      dynamicUploaded,
    });
    this._traceRecorder?.completeAt(
      'web.main',
      'frame',
      'frame',
      frameStartedMs,
      nowMs() - frameStartedMs,
      {
        runtime_status: runtimeStatus,
        overlay_uploaded: overlayUploaded,
        dynamic_uploaded: dynamicUploaded,
        slide: this._slideName,
      },
    );
  }

  teardown() {
    this._channelState.active = false;
    this._channelState.latest = null;
    this._channelState.dirty = false;

    if (this._sidecarHost) {
      this._sidecarHost.terminate();
    }

    if (this._renderer) {
      this._renderer.stop();
    }

    this._renderer = null;
    this._slideHost = null;
    this._sidecarHost = null;
    this._loaded = false;
    this._lastTimestampMs = null;
    this._compiledSceneMeshes = [];
    this._compiledSceneCameraPath = null;
    this._compiledSceneLighting = null;
    this._frameStats = createFrameStats();
  }

  stats() {
    return {
      loaded: this._loaded,
      backend: 'webgpu',
      fps: this._renderer ? this._renderer.fps : 0,
      slideName: this._slideName,
      manifestName: this._manifestName,
      sidecarActive: Boolean(this._sidecarHost),
      traceCapturing: this._traceRecorder?.capturing ?? false,
      lastError: this._lastError,
      ...this._frameStats,
    };
  }

  startTraceCapture(extraMetadata = null) {
    if (!this._traceRecorder) {
      return false;
    }
    return this._traceRecorder.startCapture(extraMetadata ?? {});
  }

  stopTraceCapture(extraMetadata = null) {
    if (!this._traceRecorder) {
      return false;
    }
    return this._traceRecorder.stopCapture(extraMetadata ?? {});
  }

  exportTrace() {
    return this._traceRecorder?.exportTrace() ?? null;
  }

  downloadTrace(filename = null) {
    if (!this._traceRecorder) {
      return false;
    }
    return this._traceRecorder.downloadTrace(filename ?? undefined);
  }
}

// wasm-bindgen imports this symbol name from the snippet module.
export { EngineBridge as JsEngineBridge };
