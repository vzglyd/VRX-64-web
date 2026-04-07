import { decodeSlideSpec } from './postcard.js';
import { createFrameStats, recordFrameStats } from './frame_stats.js';
import { VzglydRenderer } from './renderer.js';
import { createTraceRecorder } from './trace_recorder.js';
import { VzglydWasmHost } from './wasm-host.js';
import { asUint8Array, unpackBundle } from './bundle_manifest.js';
import { loadGlbScene, encodeMeshAsset, encodeSceneAnchorSet } from '../pkg/vzglyd_web.js';
import {
  createFixedStepScheduler,
  resetFixedStepScheduler,
  advanceFixedStepScheduler,
} from './fixed_step.js';

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

function formatTraceMs(value) {
  return value.toFixed(3);
}

export function buildSlideTraceContext(pkg, runtimeOptions = null) {
  const slidePath = String(runtimeOptions?.slidePath ?? '');
  const slideIndex = Number.isInteger(runtimeOptions?.slideIndex) ? runtimeOptions.slideIndex : null;
  const runtimeLabel = slidePath || pkg.manifest?.name || 'guest';
  const thread = slideIndex == null
    ? `slide:${runtimeLabel}`
    : `slide:${slideIndex}:${runtimeLabel}`;
  const args = {};
  if (slidePath) {
    args.slide_path = slidePath;
  }
  if (slideIndex != null) {
    args.slide_index = slideIndex;
  }
  return {
    thread,
    args,
    sidecarThread: thread.replace(/^slide:/, 'sidecar:'),
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
    this._traceThread = options.traceThread ?? 'sidecar:guest';
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
      traceThread: this._traceThread,
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
    this._slideName = '';
    this._manifestName = '';
    this._lastError = null;
    this._gpuState = null;
    this._compiledSceneMeshes = [];
    this._compiledSceneCameraPath = null;
    this._compiledSceneLighting = null;
    this._slideTraceThread = 'web.main';
    this._slideTraceArgs = {};
    this._sidecarTraceThread = 'web.sidecar';
    this._frameScheduler = createFixedStepScheduler();
    this._frameTiming = {};
    this._frameSample = {};
    this._renderTiming = {
      simulationTimeSecs: 0,
      alpha: 0,
      fixedStepSecs: this._frameScheduler.fixedStepMs / 1000,
      frameTimestampMs: 0,
    };
    this._timingDiagnostics = {
      clampCount: 0,
      multiStepFrameCount: 0,
      overloadDropCount: 0,
    };
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

  _isTraceCapturing() {
    return Boolean(this._traceRecorder?.capturing);
  }

  _emitTimingDiagnostic(name, args = {}) {
    const countsByName = {
      frame_dt_clamped: 'clampCount',
      frame_multi_step: 'multiStepFrameCount',
      frame_overload_drop: 'overloadDropCount',
    };
    const counterKey = countsByName[name];
    if (!counterKey) {
      return;
    }

    this._timingDiagnostics[counterKey] += 1;
    const occurrence = this._timingDiagnostics[counterKey];

    if (this._isTraceCapturing()) {
      this._traceRecorder.instant(
        this._slideTraceThread,
        'timing',
        name,
        {
          ...this._slideTraceArgs,
          occurrence,
          ...args,
        },
      );
    }

    if (occurrence === 1 || occurrence % 60 === 0) {
      console.warn(`[vzglyd] ${name}`, {
        occurrence,
        slide: this._slideName,
        ...args,
      });
    }
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
      const slideTrace = buildSlideTraceContext(pkg, runtimeOptions);
      const traceMetadata = {
        bundle_bytes: bytes.length,
        manifest_name: pkg.manifest?.name ?? '',
        manifest_version: pkg.manifest?.version ?? '',
        has_sidecar: Boolean(pkg.sidecarWasm),
        slide_path: slideTrace.args.slide_path ?? '',
        slide_index: slideTrace.args.slide_index ?? '',
        slide_thread: slideTrace.thread,
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
          slideTrace.thread,
          'bundle',
          'compile_authored_scenes',
          compileStartedMs,
          nowMs() - compileStartedMs,
          {
            ...slideTrace.args,
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
        traceThread: slideTrace.thread,
        traceCategory: 'guest.slide',
      });
      const paramsBytes = encodeRuntimeParams(runtimeOptions?.params);
      
      // Pass compiled meshes to slideHost for potential use
      slideHost._compiledSceneMeshes = this._compiledSceneMeshes || [];

      const instantiateStartedMs = nowMs();
      const slideModule = await WebAssembly.instantiate(pkg.slideWasm, slideHost.buildImports());
      this._traceRecorder?.completeAt(
        slideTrace.thread,
        'bundle',
        'instantiate_slide',
        instantiateStartedMs,
        nowMs() - instantiateStartedMs,
        {
          ...slideTrace.args,
          wasm_bytes: pkg.slideWasm.length,
        },
      );

      const runtimeInitStartedMs = nowMs();
      slideHost.setInstance(slideModule.instance);
      slideHost.runStart();
      slideHost.configureParams(paramsBytes);
      this._traceRecorder?.completeAt(
        slideTrace.thread,
        'bundle',
        'configure_slide',
        runtimeInitStartedMs,
        nowMs() - runtimeInitStartedMs,
        {
          ...slideTrace.args,
          has_params: Boolean(paramsBytes),
        },
      );

      // Note: We no longer patch the spec in WASM memory (postcard is variable-length).
      // Instead, we'll modify the decoded spec object below.
      console.log('[vzglyd] Compiled meshes ready:', slideHost._compiledSceneMeshes.length);

      const initStartedMs = nowMs();
      slideHost.runInit();
      this._traceRecorder?.completeAt(
        slideTrace.thread,
        'bundle',
        'vzglyd_init',
        initStartedMs,
        nowMs() - initStartedMs,
        slideTrace.args,
      );

      const specReadStartedMs = nowMs();
      const specWire = slideHost.readSpecBytes();
      if (specWire[0] !== WIRE_VERSION) {
        throw new Error(`unsupported slide wire version ${specWire[0]} (expected ${WIRE_VERSION})`);
      }

      let spec = decodeSlideSpec(specWire.slice(1));
      this._traceRecorder?.completeAt(
        slideTrace.thread,
        'bundle',
        'decode_spec',
        specReadStartedMs,
        nowMs() - specReadStartedMs,
        {
          ...slideTrace.args,
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
        slideTrace.thread,
        'bundle',
        'renderer_init',
        rendererInitStartedMs,
        nowMs() - rendererInitStartedMs,
        {
          ...slideTrace.args,
          canvas_width: this._canvas.width,
          canvas_height: this._canvas.height,
          dpr: globalThis.devicePixelRatio ?? 1,
        },
      );

      const initialOverlayStartedMs = nowMs();
      const initialOverlayApplied = renderer.applyOverlayBytes(slideHost.readOverlayBytes());
      this._traceRecorder?.completeAt(
        slideTrace.thread,
        'runtime',
        'initial_overlay_upload',
        initialOverlayStartedMs,
        nowMs() - initialOverlayStartedMs,
        {
          ...slideTrace.args,
          uploaded: initialOverlayApplied,
        },
      );
      const initialDynamicStartedMs = nowMs();
      const initialDynamicApplied = renderer.applyDynamicMeshBytes(slideHost.readDynamicMeshBytes());
      this._traceRecorder?.completeAt(
        slideTrace.thread,
        'runtime',
        'initial_dynamic_upload',
        initialDynamicStartedMs,
        nowMs() - initialDynamicStartedMs,
        {
          ...slideTrace.args,
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
          traceThread: slideTrace.sidecarThread,
          onTrace: (event) => this._relayWorkerTrace(event),
        });
        this._channelState.active = true;
        await sidecarHost.start(pkg.sidecarWasm.slice(), paramsBytes ? paramsBytes.slice() : null);
        this._traceRecorder?.completeAt(
          slideTrace.sidecarThread,
          'bundle',
          'start_sidecar',
          sidecarStartedMs,
          nowMs() - sidecarStartedMs,
          {
            ...slideTrace.args,
            wasm_bytes: pkg.sidecarWasm.length,
          },
        );
      }

      this._renderer = renderer;
      this._slideHost = slideHost;
      this._sidecarHost = sidecarHost;
      this._slideTraceThread = slideTrace.thread;
      this._slideTraceArgs = slideTrace.args;
      this._sidecarTraceThread = slideTrace.sidecarThread;

      this._manifestName = pkg.manifest?.name ?? '';
      this._slideName = spec?.name ?? '';
      resetFixedStepScheduler(this._frameScheduler);
      this._renderTiming.fixedStepSecs = this._frameScheduler.fixedStepMs / 1000;
      this._renderTiming.simulationTimeSecs = 0;
      this._renderTiming.alpha = 0;
      this._renderTiming.frameTimestampMs = 0;
      this._timingDiagnostics = {
        clampCount: 0,
        multiStepFrameCount: 0,
        overloadDropCount: 0,
      };
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
        slideTrace.thread,
        'bundle',
        'load_bundle',
        loadStartedMs,
        nowMs() - loadStartedMs,
        {
          ...slideTrace.args,
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
    const traceCapturing = this._isTraceCapturing();
    const slideTraceThread = this._slideTraceThread || 'web.main';
    const slideTraceArgs = traceCapturing ? (this._slideTraceArgs ?? {}) : null;
    const frameTiming = advanceFixedStepScheduler(this._frameScheduler, timestampMs, this._frameTiming);
    const fixedStepSecs = frameTiming.fixedStepMs / 1000;

    if (frameTiming.rawDeltaMs > frameTiming.clampedDeltaMs) {
      this._emitTimingDiagnostic('frame_dt_clamped', {
        raw_dt_ms: frameTiming.rawDeltaMs,
        clamped_dt_ms: frameTiming.clampedDeltaMs,
      });
    }
    if (frameTiming.fixedSteps > 1) {
      this._emitTimingDiagnostic('frame_multi_step', {
        fixed_steps: frameTiming.fixedSteps,
        raf_dt_ms: frameTiming.rawDeltaMs,
      });
    }
    if (frameTiming.overloadClamped) {
      this._emitTimingDiagnostic('frame_overload_drop', {
        fixed_steps: frameTiming.fixedSteps,
        accumulator_ms: frameTiming.accumulatorMs,
      });
    }

    let totalUpdateMs = 0;
    let runtimeStatus = 0;
    let overlayUploadMs = 0;
    let dynamicUploadMs = 0;
    let overlayUploaded = false;
    let dynamicUploaded = false;

    for (let stepIndex = 0; stepIndex < frameTiming.fixedSteps; stepIndex++) {
      const updateStartedMs = nowMs();
      const updateSample = measureCall(() => this._slideHost.update(fixedStepSecs));
      totalUpdateMs += updateSample.durationMs;
      if (updateSample.result !== 0) {
        runtimeStatus = updateSample.result;
      }

      if (traceCapturing) {
        this._traceRecorder.completeAt(
          slideTraceThread,
          'runtime',
          'vzglyd_update',
          updateStartedMs,
          updateSample.durationMs,
          {
            ...slideTraceArgs,
            dt_ms: formatTraceMs(frameTiming.fixedStepMs),
            status_code: updateSample.result,
            step_index: stepIndex + 1,
            steps_this_frame: frameTiming.fixedSteps,
            raf_dt_ms: formatTraceMs(frameTiming.rawDeltaMs),
            clamped_dt_ms: formatTraceMs(frameTiming.clampedDeltaMs),
          },
        );
      }
    }

    if (runtimeStatus !== 0) {
      const overlayStartedMs = nowMs();
      const overlaySample = measureCall(() =>
        this._renderer.applyOverlayBytes(this._slideHost.readOverlayBytes()),
      );
      overlayUploadMs = overlaySample.durationMs;
      overlayUploaded = overlaySample.result;
      if (traceCapturing) {
        this._traceRecorder.completeAt(
          slideTraceThread,
          'runtime',
          'overlay_upload',
          overlayStartedMs,
          overlayUploadMs,
          {
            ...slideTraceArgs,
            uploaded: overlayUploaded,
            status_code: runtimeStatus,
            fixed_steps: frameTiming.fixedSteps,
          },
        );
      }

      const dynamicStartedMs = nowMs();
      const dynamicSample = measureCall(() =>
        this._renderer.applyDynamicMeshBytes(this._slideHost.readDynamicMeshBytes()),
      );
      dynamicUploadMs = dynamicSample.durationMs;
      dynamicUploaded = dynamicSample.result;
      if (traceCapturing) {
        this._traceRecorder.completeAt(
          slideTraceThread,
          'runtime',
          'dynamic_upload',
          dynamicStartedMs,
          dynamicUploadMs,
          {
            ...slideTraceArgs,
            uploaded: dynamicUploaded,
            status_code: runtimeStatus,
            fixed_steps: frameTiming.fixedSteps,
          },
        );
      }
    }

    this._renderTiming.simulationTimeSecs = frameTiming.simulationTimeMs / 1000;
    this._renderTiming.alpha = frameTiming.alpha;
    this._renderTiming.fixedStepSecs = fixedStepSecs;
    this._renderTiming.frameTimestampMs = timestampMs;

    const renderStartedMs = nowMs();
    const renderSample = measureCall(() => this._renderer.renderFrame(this._renderTiming));
    if (traceCapturing) {
      this._traceRecorder.completeAt(
        slideTraceThread,
        'render',
        'render_frame',
        renderStartedMs,
        renderSample.durationMs,
        {
          ...slideTraceArgs,
          raf_dt_ms: formatTraceMs(frameTiming.rawDeltaMs),
          clamped_dt_ms: formatTraceMs(frameTiming.clampedDeltaMs),
          fixed_steps: frameTiming.fixedSteps,
          alpha: frameTiming.alpha.toFixed(3),
          simulation_time_ms: formatTraceMs(frameTiming.simulationTimeMs),
        },
      );
    }

    this._frameSample.rafDtMs = frameTiming.rawDeltaMs;
    this._frameSample.fixedSteps = frameTiming.fixedSteps;
    this._frameSample.updateMs = totalUpdateMs;
    this._frameSample.overlayUploadMs = overlayUploadMs;
    this._frameSample.dynamicUploadMs = dynamicUploadMs;
    this._frameSample.renderMs = renderSample.durationMs;
    this._frameSample.overlayUploaded = overlayUploaded;
    this._frameSample.dynamicUploaded = dynamicUploaded;
    this._frameSample.clamped = frameTiming.rawDeltaMs > frameTiming.clampedDeltaMs;
    this._frameSample.overloadClamped = frameTiming.overloadClamped;
    recordFrameStats(this._frameStats, this._frameSample);

    if (traceCapturing) {
      this._traceRecorder.completeAt(
        slideTraceThread,
        'frame',
        'frame',
        frameStartedMs,
        nowMs() - frameStartedMs,
        {
          ...slideTraceArgs,
          runtime_status: runtimeStatus,
          overlay_uploaded: overlayUploaded,
          dynamic_uploaded: dynamicUploaded,
          slide: this._slideName,
          raf_dt_ms: formatTraceMs(frameTiming.rawDeltaMs),
          clamped_dt_ms: formatTraceMs(frameTiming.clampedDeltaMs),
          fixed_steps: frameTiming.fixedSteps,
          alpha: frameTiming.alpha.toFixed(3),
          overload_clamped: frameTiming.overloadClamped,
        },
      );
    }
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
    resetFixedStepScheduler(this._frameScheduler);
    this._renderTiming.simulationTimeSecs = 0;
    this._renderTiming.alpha = 0;
    this._renderTiming.fixedStepSecs = this._frameScheduler.fixedStepMs / 1000;
    this._renderTiming.frameTimestampMs = 0;
    this._compiledSceneMeshes = [];
    this._compiledSceneCameraPath = null;
    this._compiledSceneLighting = null;
    this._slideTraceThread = 'web.main';
    this._slideTraceArgs = {};
    this._sidecarTraceThread = 'web.sidecar';
    this._timingDiagnostics = {
      clampCount: 0,
      multiStepFrameCount: 0,
      overloadDropCount: 0,
    };
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
      fixedStepMs: this._frameScheduler.fixedStepMs,
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
