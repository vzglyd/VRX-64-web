/**
 * wasm-host.js — Browser host imports for vzglyd slide and sidecar modules.
 */

class ProcExitError extends Error {
  constructor(code) {
    super(`proc_exit(${code})`);
    this.code = code;
  }
}

const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;
const WASI_EIO = 29;
const WASI_EINVAL = 28;
const WASI_ENOSYS = 52;

const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;
const EVENTTYPE_CLOCK = 0;
const SUBCLOCKFLAG_ABSTIME = 1;
const WASI_SUBSCRIPTION_SIZE = 48;
const WASI_EVENT_SIZE = 32;

const HOST_ERROR = -1;
const HOST_BUFFER_TOO_SMALL = -2;
const HOST_CHANNEL_EMPTY = -3;
const HOST_ASSET_NOT_FOUND = -4;

function traceNowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function emptyChannelState() {
  return {
    latest: null,
    dirty: false,
    active: false,
  };
}

class BaseWasmHost {
  constructor(options = {}) {
    this._instance = null;
    this._memory = null;
    this._startMs = performance.now();
    this._channelState = options.channelState ?? emptyChannelState();
    this._blockingSleep = options.blockingSleep ?? null;
    this._traceRecorder = options.traceRecorder ?? null;
    this._traceThread = options.traceThread ?? 'guest';
    this._traceCategory = options.traceCategory ?? 'guest';
    this._onTrace = options.onTrace ?? null;
    this._nextTraceSpanId = 1;
  }

  setInstance(instance) {
    this._instance = instance;
    this._memory = instance.exports.memory;
  }

  _memView() {
    return new DataView(this._memory.buffer);
  }

  _memU8() {
    return new Uint8Array(this._memory.buffer);
  }

  _readBytes(ptr, len) {
    return new Uint8Array(this._memory.buffer, ptr, len).slice();
  }

  _readString(ptr, len) {
    return new TextDecoder().decode(new Uint8Array(this._memory.buffer, ptr, len));
  }

  _writeBytes(ptr, data) {
    this._memU8().set(data, ptr);
    return data.length;
  }

  _parseTracePayload(ptr, len) {
    return JSON.parse(this._readString(ptr >>> 0, len >>> 0));
  }

  _traceSpanStart(ptr, len) {
    try {
      const payload = this._parseTracePayload(ptr, len);
      const args = payload.attrs ?? {};
      if (this._traceRecorder) {
        return this._traceRecorder.beginSpan(
          this._traceThread,
          this._traceCategory,
          payload.name,
          args,
        );
      }
      if (this._onTrace) {
        const spanId = this._nextTraceSpanId++;
        this._onTrace({
          kind: 'span_start',
          spanId,
          thread: this._traceThread,
          category: this._traceCategory,
          name: payload.name,
          args,
          atMs: traceNowMs(),
        });
        return spanId;
      }
      return 0;
    } catch {
      return HOST_ERROR;
    }
  }

  _traceSpanEnd(spanId, ptr, len) {
    try {
      const payload = len > 0 ? this._parseTracePayload(ptr, len) : {};
      const args = payload.attrs ?? {};
      if (payload.status != null) {
        args.status = payload.status;
      }
      if (this._traceRecorder) {
        this._traceRecorder.endSpan(spanId, args);
      }
      if (this._onTrace) {
        this._onTrace({
          kind: 'span_end',
          spanId,
          args,
          atMs: traceNowMs(),
        });
      }
      return WASI_ESUCCESS;
    } catch {
      return HOST_ERROR;
    }
  }

  _traceEvent(ptr, len) {
    try {
      const payload = this._parseTracePayload(ptr, len);
      const args = payload.attrs ?? {};
      if (this._traceRecorder) {
        this._traceRecorder.instant(
          this._traceThread,
          this._traceCategory,
          payload.name,
          args,
        );
      }
      if (this._onTrace) {
        this._onTrace({
          kind: 'instant',
          thread: this._traceThread,
          category: this._traceCategory,
          name: payload.name,
          args,
          atMs: traceNowMs(),
        });
      }
      return WASI_ESUCCESS;
    } catch {
      return HOST_ERROR;
    }
  }

  _traceComplete(category, name, startMs, args = {}) {
    const durationMs = traceNowMs() - startMs;
    if (this._traceRecorder) {
      this._traceRecorder.complete(this._traceThread, category, name, durationMs, args);
    }
    if (this._onTrace) {
      this._onTrace({
        kind: 'complete',
        thread: this._traceThread,
        category,
        name,
        args,
        startMs,
        durationMs,
      });
    }
  }

  configureParams(paramBytes) {
    if (!paramBytes || paramBytes.length === 0) {
      return false;
    }

    const ptrFn = this._instance?.exports?.vzglyd_params_ptr;
    const capFn = this._instance?.exports?.vzglyd_params_capacity;
    const cfgFn = this._instance?.exports?.vzglyd_configure;
    if (!ptrFn || !capFn || !cfgFn) {
      return false;
    }
    if (!this._memory) {
      throw new Error('module is missing memory export required for params');
    }

    const capacity = capFn() >>> 0;
    const ptr = ptrFn() >>> 0;
    const writeLen = Math.min(paramBytes.length, capacity);
    this._writeBytes(ptr, paramBytes.subarray(0, writeLen));
    const status = cfgFn(writeLen);
    if ((status | 0) < 0) {
      throw new Error(`vzglyd_configure(${writeLen}) failed with status ${status}`);
    }
    return true;
  }

  _clockTimeNs(clockId) {
    if (clockId === CLOCK_MONOTONIC) {
      return BigInt(Math.round((performance.now() - this._startMs) * 1_000_000));
    }
    return BigInt(Math.round(Date.now() * 1_000_000));
  }

  _buildWasiBase() {
    const self = this;

    return {
      fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
        if (fd !== 1 && fd !== 2) return WASI_EBADF;
        const view = self._memView();
        let total = 0;
        let text = '';
        for (let i = 0; i < iovsLen; i++) {
          const base = view.getUint32(iovsPtr + i * 8, true);
          const len = view.getUint32(iovsPtr + i * 8 + 4, true);
          if (len === 0) continue;
          text += new TextDecoder().decode(new Uint8Array(self._memory.buffer, base, len));
          total += len;
        }
        if (text) {
          const msg = `[vzglyd] ${text.trimEnd()}`;
          if (fd === 2) {
            console.warn(msg);
          } else {
            console.log(msg);
          }
        }
        view.setUint32(nwrittenPtr, total, true);
        return WASI_ESUCCESS;
      },

      clock_time_get(...args) {
        let clockId;
        let outPtr;
        if (args.length === 3 && typeof args[1] === 'bigint') {
          [clockId, , outPtr] = args;
        } else if (args.length === 4) {
          [clockId, , , outPtr] = args;
        } else {
          return WASI_EINVAL;
        }
        self._memView().setBigUint64(outPtr >>> 0, self._clockTimeNs(clockId), true);
        return WASI_ESUCCESS;
      },

      random_get(bufPtr, bufLen) {
        const buf = new Uint8Array(self._memory.buffer, bufPtr, bufLen);
        crypto.getRandomValues(buf);
        return WASI_ESUCCESS;
      },

      proc_exit(code) {
        throw new ProcExitError(code);
      },

      args_sizes_get(argcPtr, argvBufSizePtr) {
        const view = self._memView();
        view.setUint32(argcPtr, 0, true);
        view.setUint32(argvBufSizePtr, 0, true);
        return WASI_ESUCCESS;
      },

      args_get(_argvPtr, _argvBufPtr) {
        return WASI_ESUCCESS;
      },

      environ_sizes_get(envCountPtr, envBufSizePtr) {
        const view = self._memView();
        view.setUint32(envCountPtr, 0, true);
        view.setUint32(envBufSizePtr, 0, true);
        return WASI_ESUCCESS;
      },

      environ_get(_environPtr, _environBufPtr) {
        return WASI_ESUCCESS;
      },

      fd_close(_fd) {
        return WASI_EBADF;
      },
      fd_seek(_fd, _lo, _hi, _whence, _out) {
        return WASI_EBADF;
      },
      fd_read(_fd, _iovs, _iovsLen, _nread) {
        return WASI_EBADF;
      },
      fd_fdstat_get(_fd, _statPtr) {
        return WASI_EBADF;
      },
      fd_prestat_get(_fd, _statPtr) {
        return WASI_EBADF;
      },
      fd_prestat_dir_name(_fd, _pathPtr, _pathLen) {
        return WASI_EBADF;
      },

      path_open(
        _fd,
        _dirFlags,
        _pathPtr,
        _pathLen,
        _oFlags,
        _fsRightsBaseLo,
        _fsRightsBaseHi,
        _fsRightsInheritingLo,
        _fsRightsInheritingHi,
        _fdFlags,
        _openedFdPtr,
      ) {
        return WASI_EBADF;
      },

      path_filestat_get(_fd, _flags, _pathPtr, _pathLen, _statPtr) {
        return WASI_EBADF;
      },
      path_create_directory(_fd, _pathPtr, _pathLen) {
        return WASI_EBADF;
      },
      path_remove_directory(_fd, _pathPtr, _pathLen) {
        return WASI_EBADF;
      },
      path_unlink_file(_fd, _pathPtr, _pathLen) {
        return WASI_EBADF;
      },
      path_rename(_fd, _oldPtr, _oldLen, _newFd, _newPtr, _newLen) {
        return WASI_EBADF;
      },
      path_readlink(_fd, _p, _pl, _buf, _blen, _nread) {
        return WASI_EBADF;
      },
      path_symlink(_old, _oldLen, _fd, _new, _newLen) {
        return WASI_EBADF;
      },

      poll_oneoff(inPtr, outPtr, nsubscriptions, neventsPtr) {
        if (!self._blockingSleep) return WASI_ENOSYS;
        if (inPtr < 0 || outPtr < 0 || nsubscriptions < 0 || neventsPtr < 0) {
          return WASI_EINVAL;
        }

        const count = nsubscriptions >>> 0;
        const view = self._memView();
        const mem = self._memU8();
        let waitMs = 0;

        for (let i = 0; i < count; i++) {
          const subscriptionPtr = (inPtr >>> 0) + i * WASI_SUBSCRIPTION_SIZE;
          const eventType = view.getUint8(subscriptionPtr + 8);
          if (eventType !== EVENTTYPE_CLOCK) {
            return WASI_ENOSYS;
          }

          const clockId = view.getUint32(subscriptionPtr + 16, true);
          const timeoutNs = view.getBigUint64(subscriptionPtr + 24, true);
          const flags = view.getUint16(subscriptionPtr + 40, true);
          let relativeNs = timeoutNs;
          if ((flags & SUBCLOCKFLAG_ABSTIME) !== 0) {
            const nowNs = self._clockTimeNs(clockId);
            relativeNs = timeoutNs > nowNs ? timeoutNs - nowNs : 0n;
          }
          const currentWaitMs = Number(
            relativeNs / 1_000_000n + (relativeNs % 1_000_000n === 0n ? 0n : 1n),
          );
          waitMs = i === 0 ? currentWaitMs : Math.min(waitMs, currentWaitMs);
        }

        self._blockingSleep(waitMs);

        for (let i = 0; i < count; i++) {
          const subscriptionPtr = (inPtr >>> 0) + i * WASI_SUBSCRIPTION_SIZE;
          const eventPtr = (outPtr >>> 0) + i * WASI_EVENT_SIZE;
          mem.set(mem.slice(subscriptionPtr, subscriptionPtr + 8), eventPtr);
          mem.fill(0, eventPtr + 8, eventPtr + WASI_EVENT_SIZE);
          view.setUint16(eventPtr + 8, WASI_ESUCCESS, true);
          view.setUint8(eventPtr + 10, EVENTTYPE_CLOCK);
        }

        view.setUint32(neventsPtr >>> 0, count, true);
        return WASI_ESUCCESS;
      },

      sched_yield() {
        return WASI_ESUCCESS;
      },
    };
  }
}

export class VzglydWasmHost extends BaseWasmHost {
  constructor(options = {}) {
    super(options);
    this._meshAssets = options.meshAssets ?? new Map();
    this._sceneMetadata = options.sceneMetadata ?? new Map();
    this._compiledSceneMeshes = []; // Track compiled scene meshes for spec patching
    this._sounds = options.sounds ?? new Map(); // key -> ArrayBuffer (raw sound bytes)
    this._audioContext = options.audioContext ?? null; // Web Audio API context
    this._decodedSounds = new Map(); // key -> AudioBuffer (decoded)
    this._activeSounds = new Map(); // id -> { source, gain }
    this._nextAudioContextResumeId = 1;
  }

  /**
   * Initialize the Web Audio API context. Must be called from a user gesture
   * handler or after the page has been interacted with (browsers block autoplay).
   */
  async initAudio() {
    if (this._audioContext) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('[vzglyd] Web Audio API not available');
      return;
    }
    this._audioContext = new Ctx();
    console.log('[vzglyd] AudioContext created, sample rate:', this._audioContext.sampleRate);
  }

  /**
   * Store raw sound bytes for later playback. Called during bundle load.
   */
  addSound(key, bytes) {
    this._sounds.set(key, bytes);
  }

  /**
   * Decode a stored sound into an AudioBuffer. Must be called after initAudio().
   */
  async decodeSound(key) {
    if (this._decodedSounds.has(key)) return;
    const bytes = this._sounds.get(key);
    if (!bytes) {
      console.warn('[vzglyd] decodeSound: key not found:', key);
      return;
    }
    if (!this._audioContext) {
      await this.initAudio();
    }
    if (!this._audioContext) return;

    try {
      const audioBuffer = await this._audioContext.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      );
      this._decodedSounds.set(key, audioBuffer);
    } catch (e) {
      console.warn('[vzglyd] failed to decode sound', key, e);
    }
  }

  /**
   * Add a compiled scene mesh to be injected into the slide spec.
   * Must be called before runInit().
   */
  addCompiledSceneMesh(meshData) {
    this._compiledSceneMeshes.push(meshData);
  }

  /**
   * Patch the slide spec in WASM memory to include compiled scene meshes.
   * This writes mesh data into WASM linear memory and updates the spec header.
   * Must be called AFTER instantiation but BEFORE runInit().
   *
   * We grow WASM memory and write data at the END to avoid writing to unallocated addresses.
   */
  patchSpecWithSceneMeshes() {
    if (this._compiledSceneMeshes.length === 0) {
      console.log('[vzglyd] No compiled meshes to patch');
      return;
    }

    const ptrFn = this._instance?.exports?.vzglyd_spec_ptr;
    const lenFn = this._instance?.exports?.vzglyd_spec_len;
    const memory = this._instance?.exports?.memory;

    if (!ptrFn || !lenFn || !memory) {
      console.warn('[vzglyd] cannot patch spec: missing exports');
      return;
    }

    const specPtr = ptrFn() >>> 0;
    const specLen = lenFn() >>> 0;

    // Offsets within the spec structure (relative to specPtr)
    const staticMeshesCountOffset = specPtr + 56;
    const staticMeshesOffsetOffset = specPtr + 60;
    const drawsCountOffset = specPtr + 72;
    const drawsOffsetOffset = specPtr + 76;

    let memView = new DataView(memory.buffer);
    const oldMeshCount = memView.getUint32(staticMeshesCountOffset, true);
    const oldDrawCount = memView.getUint32(drawsCountOffset, true);
    const newMeshCount = oldMeshCount + this._compiledSceneMeshes.length;
    const newDrawCount = oldDrawCount + this._compiledSceneMeshes.length;

    console.log('[vzglyd] Patching spec: meshes', oldMeshCount, '->', newMeshCount);
    console.log('[vzglyd] Patching spec: draws', oldDrawCount, '->', newDrawCount);
    console.log('[vzglyd] Spec is at', specPtr, 'length', specLen);

    const MESH_HEADER_SIZE = 32;
    const DRAW_SIZE = 28;

    // Calculate space needed for all mesh data
    let spaceNeeded = 0;
    for (const mesh of this._compiledSceneMeshes) {
      spaceNeeded += MESH_HEADER_SIZE + 8; // header + align
      spaceNeeded += mesh.vertices.length * 48 + 8; // vertices + align
      spaceNeeded += mesh.indices.length * 2 + 8; // indices + align
      spaceNeeded += (mesh.label?.length || mesh.id.length) + 8; // label + align
      spaceNeeded += DRAW_SIZE + 8; // draw + align
    }

    // Grow WASM memory to accommodate new data
    // Round up to nearest 64KB page
    const pagesToGrow = Math.ceil(spaceNeeded / 65536);
    const grownBytes = pagesToGrow * 65536;
    memory.grow(pagesToGrow);

    // Write at the END of the newly grown memory
    const writeBase = memory.buffer.byteLength - grownBytes;
    let writePtr = writeBase;

    // Ensure 8-byte alignment
    if (writePtr % 8 !== 0) {
      writePtr += 8 - (writePtr % 8);
    }

    console.log('[vzglyd] Write base:', writePtr, 'need:', spaceNeeded, '(grew', pagesToGrow, 'pages)');

    // Recreate memory views after growth
    memView = new DataView(memory.buffer);
    let memU8 = new Uint8Array(memory.buffer);

    const newMeshOffset = writePtr;
    
    // Write mesh headers
    for (let i = 0; i < this._compiledSceneMeshes.length; i++) {
      const mesh = this._compiledSceneMeshes[i];
      const meshHeaderPtr = newMeshOffset + i * MESH_HEADER_SIZE;
      
      const labelStr = mesh.label || mesh.id;
      const labelBytes = new TextEncoder().encode(labelStr);
      memU8.set(labelBytes, writePtr);
      memView.setUint32(meshHeaderPtr, writePtr, true);
      memView.setUint32(meshHeaderPtr + 4, labelBytes.length, true);
      writePtr += labelBytes.length;
      writePtr = Math.ceil(writePtr / 8) * 8;
      
      const vertexBytes = new Uint8Array(mesh.vertices.length * 48);
      const vertexView = new DataView(vertexBytes.buffer);
      for (let j = 0; j < mesh.vertices.length; j++) {
        const v = mesh.vertices[j];
        const base = j * 48;
        vertexView.setFloat32(base + 0, v.position[0], true);
        vertexView.setFloat32(base + 4, v.position[1], true);
        vertexView.setFloat32(base + 8, v.position[2], true);
        vertexView.setFloat32(base + 12, v.normal[0], true);
        vertexView.setFloat32(base + 16, v.normal[1], true);
        vertexView.setFloat32(base + 20, v.normal[2], true);
        vertexView.setFloat32(base + 24, v.color[0], true);
        vertexView.setFloat32(base + 28, v.color[1], true);
        vertexView.setFloat32(base + 32, v.color[2], true);
        vertexView.setFloat32(base + 36, v.color[3], true);
        vertexView.setFloat32(base + 40, v.mode, true);
      }
      memU8.set(vertexBytes, writePtr);
      memView.setUint32(meshHeaderPtr + 8, writePtr, true);
      memView.setUint32(meshHeaderPtr + 12, mesh.vertices.length, true);
      memView.setUint32(meshHeaderPtr + 16, mesh.vertices.length, true);
      writePtr += vertexBytes.length;
      writePtr = Math.ceil(writePtr / 8) * 8;
      
      const indexBytes = new Uint8Array(mesh.indices.length * 2);
      const indexView = new DataView(indexBytes.buffer);
      for (let j = 0; j < mesh.indices.length; j++) {
        indexView.setUint16(j * 2, mesh.indices[j], true);
      }
      memU8.set(indexBytes, writePtr);
      memView.setUint32(meshHeaderPtr + 20, writePtr, true);
      memView.setUint32(meshHeaderPtr + 24, mesh.indices.length, true);
      memView.setUint32(meshHeaderPtr + 28, mesh.indices.length, true);
      writePtr += indexBytes.length;
      writePtr = Math.ceil(writePtr / 8) * 8;
    }

    const newDrawOffset = writePtr;
    
    // Write draw specs
    for (let i = 0; i < this._compiledSceneMeshes.length; i++) {
      const mesh = this._compiledSceneMeshes[i];
      const drawPtr = newDrawOffset + i * DRAW_SIZE;
      
      const labelStr = mesh.label || mesh.id;
      const labelBytes = new TextEncoder().encode(labelStr);
      memU8.set(labelBytes, writePtr);
      memView.setUint32(drawPtr, writePtr, true);
      memView.setUint32(drawPtr + 4, labelBytes.length, true);
      writePtr += labelBytes.length;
      writePtr = Math.ceil(writePtr / 8) * 8;
      
      memView.setUint32(drawPtr + 8, 0, true);
      memView.setUint32(drawPtr + 12, oldMeshCount + i, true);
      memView.setUint32(drawPtr + 16, mesh.pipeline === 'transparent' ? 1 : 0, true);
      memView.setUint32(drawPtr + 20, 0, true);
      memView.setUint32(drawPtr + 24, mesh.indices.length, true);
    }

    // Update header
    memView.setUint32(staticMeshesCountOffset, newMeshCount, true);
    memView.setUint32(staticMeshesOffsetOffset, newMeshOffset, true);
    memView.setUint32(drawsCountOffset, newDrawCount, true);
    memView.setUint32(drawsOffsetOffset, newDrawOffset, true);

    console.log('[vzglyd] Spec patched successfully!');
    console.log('[vzglyd] Used', writePtr - writeBase, 'bytes');
  }

  runStart() {
    const startFn = this._instance?.exports?._start;
    if (!startFn) return;
    try {
      startFn();
    } catch (e) {
      if (e instanceof ProcExitError && e.code === 0) return;
      throw e;
    }
  }

  runInit() {
    const fn = this._instance?.exports?.vzglyd_init;
    if (!fn) return;
    try {
      fn();
    } catch (e) {
      if (e instanceof ProcExitError && e.code === 0) return;
      throw e;
    }
  }

  readSpecBytes() {
    const ptrFn = this._instance?.exports?.vzglyd_spec_ptr;
    const lenFn = this._instance?.exports?.vzglyd_spec_len;
    if (!ptrFn || !lenFn) {
      throw new Error('slide is missing vzglyd_spec_ptr / vzglyd_spec_len exports');
    }
    const ptr = ptrFn() >>> 0;
    const len = lenFn() >>> 0;
    if (len === 0) throw new Error('vzglyd_spec_len returned 0');
    return this._readBytes(ptr, len);
  }

  update(dtSecs) {
    const fn = this._instance?.exports?.vzglyd_update;
    if (!fn) return 0;
    return fn(dtSecs) | 0;
  }

  readOverlayBytes() {
    const ptrFn = this._instance?.exports?.vzglyd_overlay_ptr;
    const lenFn = this._instance?.exports?.vzglyd_overlay_len;
    if (!ptrFn || !lenFn) return null;
    const ptr = ptrFn() >>> 0;
    const len = lenFn() >>> 0;
    if (len === 0) return null;
    return this._readBytes(ptr, len);
  }

  readDynamicMeshBytes() {
    const ptrFn = this._instance?.exports?.vzglyd_dynamic_meshes_ptr;
    const lenFn = this._instance?.exports?.vzglyd_dynamic_meshes_len;
    if (!ptrFn || !lenFn) return null;
    const ptr = ptrFn() >>> 0;
    const len = lenFn() >>> 0;
    if (len === 0) return null;
    return this._readBytes(ptr, len);
  }

  _readAssetKey(keyPtr, keyLen) {
    return this._readString(keyPtr >>> 0, keyLen >>> 0);
  }

  _assetLen(map, key) {
    const bytes = map.get(key);
    return bytes ? bytes.length : HOST_ASSET_NOT_FOUND;
  }

  _assetRead(map, key, bufPtr, bufLen) {
    const bytes = map.get(key);
    if (!bytes) return HOST_ASSET_NOT_FOUND;
    if (bytes.length > bufLen) return HOST_BUFFER_TOO_SMALL;
    this._writeBytes(bufPtr, bytes);
    return bytes.length;
  }

  _buildVzglydHost() {
    const self = this;
    return {
      channel_poll(bufPtr, bufLen) {
        if (bufPtr < 0 || bufLen < 0) return HOST_ERROR;
        const state = self._channelState;
        if (!state.latest || !state.dirty) return HOST_CHANNEL_EMPTY;
        if (state.latest.length > (bufLen >>> 0)) return HOST_BUFFER_TOO_SMALL;
        self._writeBytes(bufPtr >>> 0, state.latest);
        state.dirty = false;
        if (self._traceRecorder) {
          self._traceRecorder.instant(self._traceThread, 'channel', 'channel_poll', {
            bytes: state.latest.length,
          });
        }
        return state.latest.length | 0;
      },

      channel_active() {
        return self._channelState.active ? 1 : 0;
      },

      log_info(ptr, len) {
        try {
          const msg = self._readString(ptr >>> 0, len >>> 0);
          console.log('[vzglyd]', msg);
          if (self._traceRecorder) {
            self._traceRecorder.instant(self._traceThread, 'guest.log', 'slide_log', {
              message: msg,
            });
          }
          return WASI_ESUCCESS;
        } catch {
          return HOST_ERROR;
        }
      },

      trace_span_start(ptr, len) {
        return self._traceSpanStart(ptr, len);
      },

      trace_span_end(spanId, ptr, len) {
        return self._traceSpanEnd(spanId, ptr, len);
      },

      trace_event(ptr, len) {
        return self._traceEvent(ptr, len);
      },

      mesh_asset_len(keyPtr, keyLen) {
        try {
          const key = self._readAssetKey(keyPtr, keyLen);
          const len = self._assetLen(self._meshAssets, key);
          console.log('[vzglyd host] mesh_asset_len:', key, '->', len);
          return len;
        } catch (e) {
          console.error('[vzglyd host] mesh_asset_len error:', e);
          return HOST_ERROR;
        }
      },

      mesh_asset_read(keyPtr, keyLen, bufPtr, bufLen) {
        try {
          const key = self._readAssetKey(keyPtr, keyLen);
          const result = self._assetRead(self._meshAssets, key, bufPtr >>> 0, bufLen >>> 0);
          console.log('[vzglyd host] mesh_asset_read:', key, '->', result);
          return result;
        } catch (e) {
          console.error('[vzglyd host] mesh_asset_read error:', e);
          return HOST_ERROR;
        }
      },

      scene_metadata_len(keyPtr, keyLen) {
        try {
          const key = self._readAssetKey(keyPtr, keyLen);
          return self._assetLen(self._sceneMetadata, key);
        } catch {
          return HOST_ERROR;
        }
      },

      scene_metadata_read(keyPtr, keyLen, bufPtr, bufLen) {
        try {
          const key = self._readAssetKey(keyPtr, keyLen);
          return self._assetRead(self._sceneMetadata, key, bufPtr >>> 0, bufLen >>> 0);
        } catch {
          return HOST_ERROR;
        }
      },

      audio_play(id, keyPtr, keyLen, volume, looped) {
        try {
          const key = self._readString(keyPtr >>> 0, keyLen >>> 0);
          const audioBuffer = self._decodedSounds.get(key);
          if (!audioBuffer) {
            console.warn('[vzglyd] audio_play: sound key not decoded:', key);
            return HOST_ASSET_NOT_FOUND;
          }
          // Stop any existing sound with the same id
          self._stopSoundById(id);

          if (!self._audioContext) {
            console.warn('[vzglyd] audio_play: no AudioContext');
            return HOST_ERROR;
          }

          // Resume audio context if suspended (browser autoplay policy)
          if (self._audioContext.state === 'suspended') {
            self._audioContext.resume().catch(() => {});
          }

          const source = self._audioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.loop = !!looped;

          const gain = self._audioContext.createGain();
          gain.gain.value = Math.max(0, Math.min(1, volume));

          source.connect(gain);
          gain.connect(self._audioContext.destination);
          source.start();

          self._activeSounds.set(id, { source, gain });
          source.onended = () => {
            self._activeSounds.delete(id);
          };

          console.log('[vzglyd] audio_play:', id, key, 'vol=' + volume.toFixed(2), 'looped=' + !!looped);
          return WASI_ESUCCESS;
        } catch (e) {
          console.error('[vzglyd] audio_play error:', e);
          return HOST_ERROR;
        }
      },

      audio_stop(id) {
        try {
          self._stopSoundById(id);
          console.log('[vzglyd] audio_stop:', id);
          return WASI_ESUCCESS;
        } catch (e) {
          console.error('[vzglyd] audio_stop error:', e);
          return HOST_ERROR;
        }
      },

      audio_set_volume(id, volume) {
        try {
          const sound = self._activeSounds.get(id);
          if (sound) {
            sound.gain.gain.value = Math.max(0, Math.min(1, volume));
          }
          console.log('[vzglyd] audio_set_volume:', id, 'vol=' + volume.toFixed(2));
          return WASI_ESUCCESS;
        } catch (e) {
          console.error('[vzglyd] audio_set_volume error:', e);
          return HOST_ERROR;
        }
      },

      audio_pause(id) {
        try {
          const sound = self._activeSounds.get(id);
          if (sound && self._audioContext) {
            // Suspend only this sound's context is not possible; use source pause
            sound.source.playbackRate.value = 0;
          }
          console.log('[vzglyd] audio_pause:', id);
          return WASI_ESUCCESS;
        } catch (e) {
          console.error('[vzglyd] audio_pause error:', e);
          return HOST_ERROR;
        }
      },

      audio_resume(id) {
        try {
          const sound = self._activeSounds.get(id);
          if (sound) {
            sound.source.playbackRate.value = 1;
          }
          console.log('[vzglyd] audio_resume:', id);
          return WASI_ESUCCESS;
        } catch (e) {
          console.error('[vzglyd] audio_resume error:', e);
          return HOST_ERROR;
        }
      },
    };
  }

  _stopSoundById(id) {
    const sound = this._activeSounds.get(id);
    if (sound) {
      try {
        sound.source.stop();
      } catch {
        // Already stopped
      }
      this._activeSounds.delete(id);
    }
  }

  buildImports() {
    return {
      wasi_snapshot_preview1: this._buildWasiBase(),
      vzglyd_host: this._buildVzglydHost(),
    };
  }
}

export class VzglydSidecarHost extends BaseWasmHost {
  constructor(options = {}) {
    super(options);
    this._networkPolicy = options.networkPolicy ?? 'any_https';
    this._endpointMap = options.endpointMap ?? {};
    this._onChannelPush = options.onChannelPush ?? null;
    this._onNetworkRequest = options.onNetworkRequest ?? null;
    this._onLog = options.onLog ?? null;
    this._lastNetworkResponse = null;
  }

  run() {
    const runFn = this._instance?.exports?.vzglyd_sidecar_run;
    if (runFn) {
      try {
        runFn();
        return;
      } catch (e) {
        if (e instanceof ProcExitError && e.code === 0) return;
        throw e;
      }
    }

    const startFn = this._instance?.exports?._start;
    if (!startFn) {
      throw new Error('sidecar module is missing vzglyd_sidecar_run and _start');
    }

    try {
      startFn();
    } catch (e) {
      if (e instanceof ProcExitError && e.code === 0) return;
      throw e;
    }
  }

  _logSidecar(message) {
    if (this._onLog) {
      this._onLog(message);
      return;
    }
    console.log('[vzglyd][sidecar]', message);
  }

  _emitChannelPush(bytes) {
    if (this._onChannelPush) {
      this._onChannelPush(bytes);
      return;
    }
    this._channelState.latest = bytes;
    this._channelState.dirty = true;
  }

  _emitNetworkRequest() {
    const wallClockMs = Date.now();
    if (this._onNetworkRequest) {
      this._onNetworkRequest(wallClockMs);
    }
    return wallClockMs;
  }

  _requestEndpointFor(host, path) {
    const mapped = this._endpointMap[host] ?? this._endpointMap[`${host}:443`];
    if (mapped) {
      return new URL(path, mapped).toString();
    }
    if (this._networkPolicy === 'any_https') {
      return `https://${host}${path}`;
    }
    return null;
  }

  _syncHttpGet(url, headers) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.responseType = 'arraybuffer';
    for (const header of headers) {
      xhr.setRequestHeader(header.name, header.value);
    }
    xhr.send(null);
    return {
      statusCode: xhr.status,
      headers: this._parseResponseHeaders(xhr.getAllResponseHeaders()),
      body: new Uint8Array(xhr.response ?? new ArrayBuffer(0)),
    };
  }

  _parseResponseHeaders(rawHeaders) {
    if (!rawHeaders) return [];
    return rawHeaders
      .trim()
      .split(/[\r\n]+/)
      .map((line) => {
        const separator = line.indexOf(':');
        if (separator === -1) return null;
        return {
          name: line.slice(0, separator).trim(),
          value: line.slice(separator + 1).trim(),
        };
      })
      .filter(Boolean);
  }

  _encodeResponse(payload) {
    return new TextEncoder().encode(
      JSON.stringify({
        wire_version: 1,
        ...payload,
      }),
    );
  }

  _decodeRequest(bytes) {
    const request = JSON.parse(new TextDecoder().decode(bytes));
    if (request?.wire_version !== 1) {
      throw new Error(`unsupported host request wire version ${request?.wire_version}`);
    }
    return request;
  }

  _executeNetworkRequest(bytes) {
    try {
      const request = this._decodeRequest(bytes);
      if (request.kind === 'https_get') {
        const endpoint = this._requestEndpointFor(request.host, request.path);
        if (!endpoint) {
          return this._encodeResponse({
            kind: 'error',
            error_kind: 'io',
            message: `browser host denied request for ${request.host}${request.path}`,
          });
        }
        const response = this._syncHttpGet(endpoint, request.headers ?? []);
        return this._encodeResponse({
          kind: 'http',
          status_code: response.statusCode,
          headers: response.headers,
          body: Array.from(response.body),
        });
      }
      if (request.kind === 'tcp_connect') {
        return this._encodeResponse({
          kind: 'error',
          error_kind: 'io',
          message: 'tcp_connect is unsupported in the browser host',
        });
      }
      return this._encodeResponse({
        kind: 'error',
        error_kind: 'io',
        message: `unsupported request kind '${request.kind}'`,
      });
    } catch (error) {
      return this._encodeResponse({
        kind: 'error',
        error_kind: 'io',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  _buildVzglydHost() {
    const self = this;
    return {
      channel_push(ptr, len) {
        if (ptr < 0 || len < 0) return HOST_ERROR;
        try {
          const bytes = self._readBytes(ptr >>> 0, len >>> 0);
          self._emitChannelPush(bytes);
          if (self._traceRecorder) {
            self._traceRecorder.instant(self._traceThread, 'channel', 'channel_push', {
              bytes: bytes.length,
            });
          }
          if (self._onTrace) {
            self._onTrace({
              kind: 'instant',
              thread: self._traceThread,
              category: 'channel',
              name: 'channel_push',
              args: { bytes: String(bytes.length) },
              atMs: traceNowMs(),
            });
          }
          return WASI_ESUCCESS;
        } catch {
          return HOST_ERROR;
        }
      },

      channel_poll(_ptr, _len) {
        return HOST_CHANNEL_EMPTY;
      },

      log_info(ptr, len) {
        try {
          const msg = self._readString(ptr >>> 0, len >>> 0);
          self._logSidecar(msg);
          if (self._traceRecorder) {
            self._traceRecorder.instant(self._traceThread, 'guest.log', 'sidecar_log', {
              message: msg,
            });
          }
          return WASI_ESUCCESS;
        } catch {
          return HOST_ERROR;
        }
      },

      trace_span_start(ptr, len) {
        return self._traceSpanStart(ptr, len);
      },

      trace_span_end(spanId, ptr, len) {
        return self._traceSpanEnd(spanId, ptr, len);
      },

      trace_event(ptr, len) {
        return self._traceEvent(ptr, len);
      },

      channel_active() {
        return self._channelState.active ? 1 : 0;
      },

      network_request(ptr, len) {
        if (ptr < 0 || len < 0) return HOST_ERROR;
        try {
          const startedAtMs = traceNowMs();
          const requestBytes = self._readBytes(ptr >>> 0, len >>> 0);
          self._emitNetworkRequest();
          self._lastNetworkResponse = self._executeNetworkRequest(requestBytes);
          self._traceComplete('host', 'network_request', startedAtMs, {
            request_bytes: requestBytes.length,
            response_bytes: self._lastNetworkResponse?.length ?? 0,
          });
          return WASI_ESUCCESS;
        } catch {
          self._lastNetworkResponse = null;
          return HOST_ERROR;
        }
      },

      network_response_len() {
        return self._lastNetworkResponse ? self._lastNetworkResponse.length : 0;
      },

      network_response_read(ptr, len) {
        if (ptr < 0 || len < 0) return HOST_ERROR;
        if (!self._lastNetworkResponse) return 0;
        if (self._lastNetworkResponse.length > (len >>> 0)) {
          return HOST_BUFFER_TOO_SMALL;
        }
        self._writeBytes(ptr >>> 0, self._lastNetworkResponse);
        return self._lastNetworkResponse.length;
      },
    };
  }

  buildImports() {
    return {
      wasi_snapshot_preview1: this._buildWasiBase(),
      vzglyd_host: this._buildVzglydHost(),
    };
  }
}

export {
  HOST_ASSET_NOT_FOUND,
  HOST_BUFFER_TOO_SMALL,
  HOST_CHANNEL_EMPTY,
  HOST_ERROR,
  ProcExitError,
  WASI_EBADF,
  WASI_EINVAL,
  WASI_EIO,
  WASI_ENOSYS,
  WASI_ESUCCESS,
};
