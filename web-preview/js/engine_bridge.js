import { decodeSlideSpec } from './postcard.js';
import { VzglydRenderer } from './renderer.js';
import { VzglydSidecarHost, VzglydWasmHost } from './wasm-host.js';
import { loadGlbScene, encodeMeshAsset, encodeSceneAnchorSet } from '../pkg/vzglyd_web.js';

const WIRE_VERSION = 1;

function asUint8Array(bytesLike) {
  if (bytesLike instanceof Uint8Array) return bytesLike;
  if (ArrayBuffer.isView(bytesLike)) {
    return new Uint8Array(bytesLike.buffer, bytesLike.byteOffset, bytesLike.byteLength);
  }
  if (bytesLike instanceof ArrayBuffer) {
    return new Uint8Array(bytesLike);
  }
  throw new Error('expected Uint8Array-compatible bundle bytes');
}

function archiveEntries(bundleBytes) {
  const fflateApi = globalThis.fflate;
  if (!fflateApi || typeof fflateApi.unzipSync !== 'function') {
    throw new Error('fflate unzipSync API unavailable; include fflate before loading app.js');
  }

  return Object.entries(fflateApi.unzipSync(bundleBytes)).map(([path, bytes]) => ({
    path,
    base: path.split('/').filter(Boolean).pop() ?? path,
    bytes,
  }));
}

function pickEntry(entries, preferredBaseNames) {
  for (const baseName of preferredBaseNames) {
    const exact = entries.find((entry) => entry.base === baseName);
    if (exact) return exact;
  }
  return null;
}

function parseManifest(manifestBytes) {
  const manifestJson = new TextDecoder().decode(manifestBytes);
  return JSON.parse(manifestJson);
}

function unpackBundle(bundleBytes) {
  const entries = archiveEntries(bundleBytes);
  if (entries.length === 0) {
    throw new Error('archive is empty');
  }

  const manifestEntry =
    pickEntry(entries, ['manifest.json']) ??
    entries.find((entry) => entry.base.endsWith('_slide.json'));
  const slideWasmEntry =
    pickEntry(entries, ['slide.wasm']) ??
    entries.find((entry) => entry.base.endsWith('_slide.wasm'));
  const sidecarEntry = pickEntry(entries, ['sidecar.wasm']);

  if (!manifestEntry) {
    throw new Error('bundle is missing manifest.json');
  }
  if (!slideWasmEntry) {
    throw new Error('bundle is missing slide.wasm');
  }

  const manifest = parseManifest(manifestEntry.bytes);

  const miscAssets = new Map();
  for (const entry of entries) {
    if (entry.path === manifestEntry.path || entry.path === slideWasmEntry.path) continue;
    miscAssets.set(entry.path, entry.bytes);
    miscAssets.set(entry.base, entry.bytes);
  }

  return {
    manifest,
    slideWasm: slideWasmEntry.bytes,
    sidecarWasm: sidecarEntry?.bytes ?? null,
    miscAssets,
  };
}

function validateManifest(manifest) {
  if (manifest.scene_space && !['screen_2d', 'world_3d'].includes(manifest.scene_space)) {
    throw new Error(`manifest.scene_space '${manifest.scene_space}' is unsupported`);
  }
  if (manifest.display?.duration_seconds != null) {
    const seconds = Number(manifest.display.duration_seconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) {
      throw new Error('manifest.display.duration_seconds must be in [1, 300]');
    }
  }
}

function requiresAuthoredSceneCompilation(manifest) {
  return Array.isArray(manifest?.assets?.scenes) && manifest.assets.scenes.length > 0;
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
  }

  async loadBundle(bundleBytes, runtimeOptions = null) {
    this.teardown();

    try {
      const bytes = asUint8Array(bundleBytes);
      const pkg = unpackBundle(bytes);
      validateManifest(pkg.manifest);

      const meshAssets = new Map(pkg.miscAssets);
      const sceneMetadata = new Map(pkg.miscAssets);

      // Handle authored scene compilation if needed
      if (requiresAuthoredSceneCompilation(pkg.manifest)) {
        await this.compileAuthoredScenes(pkg.manifest, pkg.miscAssets, meshAssets, sceneMetadata);
      }

      const slideHost = new VzglydWasmHost({
        channelState: this._channelState,
        meshAssets,
        sceneMetadata,
      });
      
      // Pass compiled meshes to slideHost for potential use
      slideHost._compiledSceneMeshes = this._compiledSceneMeshes || [];

      const slideModule = await WebAssembly.instantiate(pkg.slideWasm, slideHost.buildImports());
      slideHost.setInstance(slideModule.instance);
      slideHost.runStart();

      // Note: We no longer patch the spec in WASM memory (postcard is variable-length).
      // Instead, we'll modify the decoded spec object below.
      console.log('[vzglyd] Compiled meshes ready:', slideHost._compiledSceneMeshes.length);

      slideHost.runInit();

      const specWire = slideHost.readSpecBytes();
      if (specWire[0] !== WIRE_VERSION) {
        throw new Error(`unsupported slide wire version ${specWire[0]} (expected ${WIRE_VERSION})`);
      }

      let spec = decodeSlideSpec(specWire.slice(1));
      
      // Append compiled GLB meshes to the spec
      if (this._compiledSceneMeshes && this._compiledSceneMeshes.length > 0) {
        console.log('[vzglyd] Adding', this._compiledSceneMeshes.length, 'compiled meshes to spec');
        
        for (const mesh of this._compiledSceneMeshes) {
          // Add to static_meshes
          spec.static_meshes.push({
            label: mesh.label || mesh.id,
            vertices: mesh.vertices,
            indices: mesh.indices,
          });
          
          // Add corresponding draw spec
          const meshIndex = spec.static_meshes.length - 1;
          spec.draws.push({
            label: mesh.label || mesh.id,
            source: { kind: 'Static', index: meshIndex },
            pipeline: mesh.pipeline === 'transparent' ? 'Transparent' : 'Opaque',
            index_range: { start: 0, end: mesh.indices.length },
          });
        }
        
        console.log('[vzglyd] Spec now has', spec.static_meshes.length, 'meshes and', spec.draws.length, 'draws');
      }
      
      const renderer = new VzglydRenderer(this._canvas, spec);
      await renderer.init();

      renderer.applyOverlayBytes(slideHost.readOverlayBytes());
      renderer.applyDynamicMeshBytes(slideHost.readDynamicMeshBytes());

      let sidecarHost = null;
      if (pkg.sidecarWasm) {
        if (!this._hostConfig?.allowMainThreadSidecar) {
          throw new Error(
            'bundle includes sidecar.wasm; sidecar runtime is disabled in browser host to avoid UI thread freezes',
          );
        }

        sidecarHost = new VzglydSidecarHost({
          channelState: this._channelState,
          networkPolicy: this._hostConfig?.networkPolicy ?? 'any_https',
          endpointMap: this._hostConfig?.sidecarEndpoints ?? {},
        });
        this._channelState.active = true;
        const sidecarModule = await WebAssembly.instantiate(
          pkg.sidecarWasm,
          sidecarHost.buildImports(),
        );
        sidecarHost.setInstance(sidecarModule.instance);
        sidecarHost.run();
      }

      this._renderer = renderer;
      this._slideHost = slideHost;
      this._sidecarHost = sidecarHost;

      this._manifestName = pkg.manifest?.name ?? '';
      this._slideName = spec?.name ?? '';
      this._lastTimestampMs = null;
      this._lastError = null;
      this._loaded = true;

      if (runtimeOptions?.logLoadSummary) {
        console.info('[vzglyd] loaded bundle', {
          manifest: this._manifestName,
          slide: this._slideName,
          sidecar: Boolean(pkg.sidecarWasm),
        });
      }
    } catch (error) {
      this._lastError = error instanceof Error ? error.message : String(error);
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
        
        // Store mesh data for spec patching
        this._compiledSceneMeshes.push({
          id: mesh.id,
          label: mesh.label,
          vertices: mesh.vertices,
          indices: mesh.indices,
          pipeline: mesh.pipeline,
        });
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

    const dt = this._lastTimestampMs == null
      ? 1 / 60
      : Math.max(0, Math.min(0.25, (timestampMs - this._lastTimestampMs) / 1000));
    this._lastTimestampMs = timestampMs;

    const runtimeStatus = this._slideHost.update(dt);
    if (runtimeStatus !== 0) {
      this._renderer.applyOverlayBytes(this._slideHost.readOverlayBytes());
      this._renderer.applyDynamicMeshBytes(this._slideHost.readDynamicMeshBytes());
    }

    this._renderer.renderFrame(dt);
  }

  teardown() {
    this._channelState.active = false;

    if (this._renderer) {
      this._renderer.stop();
    }

    this._renderer = null;
    this._slideHost = null;
    this._sidecarHost = null;
    this._loaded = false;
    this._lastTimestampMs = null;
  }

  stats() {
    return {
      loaded: this._loaded,
      backend: 'webgpu',
      fps: this._renderer ? this._renderer.fps : 0,
      slideName: this._slideName,
      manifestName: this._manifestName,
      sidecarActive: Boolean(this._sidecarHost),
      lastError: this._lastError,
    };
  }
}

// wasm-bindgen imports this symbol name from the snippet module.
export { EngineBridge as JsEngineBridge };
