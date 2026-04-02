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

const HOST_ERROR = -1;
const HOST_BUFFER_TOO_SMALL = -2;
const HOST_CHANNEL_EMPTY = -3;
const HOST_ASSET_NOT_FOUND = -4;

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

      clock_time_get(clockId, _precisionLo, _precisionHi, outPtr) {
        let ns;
        if (clockId === CLOCK_MONOTONIC) {
          ns = BigInt(Math.round((performance.now() - self._startMs) * 1_000_000));
        } else {
          ns = BigInt(Math.round(Date.now() * 1_000_000));
        }
        self._memView().setBigUint64(outPtr, ns, true);
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

      poll_oneoff(_in, _out, _nsubscriptions, _neventsPtr) {
        return WASI_ENOSYS;
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
        return state.latest.length | 0;
      },

      channel_active() {
        return self._channelState.active ? 1 : 0;
      },

      log_info(ptr, len) {
        try {
          const msg = self._readString(ptr >>> 0, len >>> 0);
          console.log('[vzglyd]', msg);
          return WASI_ESUCCESS;
        } catch {
          return HOST_ERROR;
        }
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
    };
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
    this._nextFd = 100;
    this._sockets = new Map();
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

  _writeU32(ptr, value) {
    this._memView().setUint32(ptr >>> 0, value >>> 0, true);
  }

  _writeU16(ptr, value) {
    this._memView().setUint16(ptr >>> 0, value >>> 0, true);
  }

  _readIovecs(iovecsPtr, iovecsLen) {
    const view = this._memView();
    const regions = [];
    for (let i = 0; i < iovecsLen; i++) {
      const base = view.getUint32((iovecsPtr >>> 0) + i * 8, true);
      const len = view.getUint32((iovecsPtr >>> 0) + i * 8 + 4, true);
      regions.push([base, len]);
    }
    return regions;
  }

  _decodeSockAddr(addrPtr, addrLen) {
    const bytes = this._readBytes(addrPtr >>> 0, addrLen >>> 0);
    if (bytes.length < 8) {
      throw new Error('invalid sockaddr bytes');
    }
    const port = (bytes[2] << 8) | bytes[3];
    const ip = `${bytes[4]}.${bytes[5]}.${bytes[6]}.${bytes[7]}`;
    return { ip, port };
  }

  _socketEndpointFor(ip, port) {
    const key = `${ip}:${port}`;
    const mapped = this._endpointMap[key];
    if (mapped) {
      return mapped;
    }
    if (this._networkPolicy === 'any_https') {
      return `https://${ip}:${port}/`;
    }
    return null;
  }

  _syncHttpPost(url, body) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, false);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(body);
    if (xhr.status >= 200 && xhr.status < 300) {
      return new Uint8Array(xhr.response ?? new ArrayBuffer(0));
    }
    throw new Error(`HTTP ${xhr.status}`);
  }

  _buildSocketExtension() {
    const self = this;
    return {
      sock_open(_af, _socktype, _proto, fdOutPtr) {
        try {
          const fd = self._nextFd++;
          self._sockets.set(fd, {
            endpoint: null,
            recvBuffer: new Uint8Array(0),
            recvOffset: 0,
          });
          self._writeU32(fdOutPtr, fd);
          return WASI_ESUCCESS;
        } catch {
          return WASI_EIO;
        }
      },

      sock_connect(fd, addrPtr, addrLen) {
        const socket = self._sockets.get(fd);
        if (!socket) return WASI_EBADF;
        try {
          const { ip, port } = self._decodeSockAddr(addrPtr, addrLen);
          const endpoint = self._socketEndpointFor(ip, port);
          if (!endpoint) {
            return WASI_EINVAL;
          }
          socket.endpoint = endpoint;
          return WASI_ESUCCESS;
        } catch {
          return WASI_EINVAL;
        }
      },

      sock_send(fd, siDataPtr, siDataLen, _siFlags, datalenOutPtr) {
        const socket = self._sockets.get(fd);
        if (!socket) return WASI_EBADF;
        if (!socket.endpoint) return WASI_EINVAL;

        try {
          if (socket.endpoint.startsWith('ws://') || socket.endpoint.startsWith('wss://')) {
            return WASI_ENOSYS;
          }

          const regions = self._readIovecs(siDataPtr, siDataLen);
          const chunks = regions.map(([ptr, len]) => self._readBytes(ptr, len));
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const body = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }

          socket.recvBuffer = self._syncHttpPost(socket.endpoint, body);
          socket.recvOffset = 0;
          self._writeU32(datalenOutPtr, body.length);
          return WASI_ESUCCESS;
        } catch {
          return WASI_EIO;
        }
      },

      sock_recv(fd, riDataPtr, riDataLen, _riFlags, datalenOutPtr, roflagsOutPtr) {
        const socket = self._sockets.get(fd);
        if (!socket) return WASI_EBADF;

        try {
          const regions = self._readIovecs(riDataPtr, riDataLen);
          let written = 0;
          for (const [ptr, len] of regions) {
            const remaining = socket.recvBuffer.length - socket.recvOffset;
            if (remaining <= 0) break;
            const chunkLen = Math.min(len, remaining);
            self._writeBytes(
              ptr,
              socket.recvBuffer.subarray(socket.recvOffset, socket.recvOffset + chunkLen),
            );
            socket.recvOffset += chunkLen;
            written += chunkLen;
          }
          self._writeU32(datalenOutPtr, written);
          self._writeU16(roflagsOutPtr, 0);
          return WASI_ESUCCESS;
        } catch {
          return WASI_EIO;
        }
      },

      sock_shutdown(fd, _how) {
        if (!self._sockets.has(fd)) return WASI_EBADF;
        self._sockets.delete(fd);
        return WASI_ESUCCESS;
      },
    };
  }

  _buildVzglydHost() {
    const self = this;
    return {
      channel_push(ptr, len) {
        if (ptr < 0 || len < 0) return HOST_ERROR;
        try {
          const bytes = self._readBytes(ptr >>> 0, len >>> 0);
          self._channelState.latest = bytes;
          self._channelState.dirty = true;
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
          console.log('[vzglyd][sidecar]', msg);
          return WASI_ESUCCESS;
        } catch {
          return HOST_ERROR;
        }
      },

      channel_active() {
        return self._channelState.active ? 1 : 0;
      },
    };
  }

  buildImports() {
    return {
      wasi_snapshot_preview1: {
        ...this._buildWasiBase(),
        ...this._buildSocketExtension(),
      },
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
