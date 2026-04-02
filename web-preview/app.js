/**
 * app.js — thin UI shell for the Rust WebHost runtime.
 */

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const canvasContainer = document.getElementById('canvas-container');
const canvas = document.getElementById('render-canvas');
const slideName = document.getElementById('slide-name');
const slideFps = document.getElementById('slide-fps');
const backBtn = document.getElementById('back-btn');
const statusBar = document.getElementById('status-bar');
const statusSpinner = document.getElementById('status-spinner');
const statusText = document.getElementById('status-text');
const errorBox = document.getElementById('error-box');
const errorText = document.getElementById('error-text');
const errorDismiss = document.getElementById('error-dismiss');
const noWebgpu = document.getElementById('no-webgpu');
const fileOriginWarning = document.getElementById('file-origin-warning');

let webHost = null;
let rafId = null;
let lastTimestamp = 0;

function setStatus(message, spinning = false) {
  statusBar.hidden = false;
  statusText.textContent = message;
  statusSpinner.hidden = !spinning;
}

function clearStatus() {
  statusBar.hidden = true;
  statusText.textContent = '';
  statusSpinner.hidden = true;
}

function showError(message) {
  errorBox.hidden = false;
  errorText.textContent = message;
  console.error('[vzglyd]', message);
}

function hideError() {
  errorBox.hidden = true;
}

function resetCanvasUi() {
  canvasContainer.hidden = true;
  dropZone.hidden = false;
  slideName.textContent = '';
  slideFps.textContent = '';
}

async function checkWebGpuSupport() {
  if (!navigator.gpu) {
    dropZone.hidden = true;
    noWebgpu.hidden = false;
    return false;
  }

  if (location.protocol === 'file:') {
    dropZone.hidden = true;
    fileOriginWarning.hidden = false;
    return false;
  }

  const adapter =
    await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) ??
    await navigator.gpu.requestAdapter() ??
    await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });

  if (!adapter) {
    dropZone.hidden = true;
    noWebgpu.hidden = false;
    return false;
  }

  return true;
}

async function initHost() {
  if (!(await checkWebGpuSupport())) {
    return false;
  }

  setStatus('Loading engine...', true);
  try {
    const { default: init, WebHost } = await import('./pkg/vzglyd_web.js');
    await init();

    webHost = new WebHost(canvas, {
      networkPolicy: 'any_https',
    });

    setStatus('Ready. Drop a .vzglyd file.', false);
    return true;
  } catch (error) {
    showError(`Failed to initialize runtime: ${error.message}`);
    return false;
  }
}

async function loadBundleFile(file) {
  if (!webHost) {
    showError('Host is not initialized');
    return;
  }

  try {
    hideError();
    setStatus(`Loading ${file.name}...`, true);

    const bytes = new Uint8Array(await file.arrayBuffer());
    await webHost.loadBundle(bytes, { logLoadSummary: true });

    const stats = webHost.stats() || {};
    slideName.textContent = stats.slideName || file.name;
    dropZone.hidden = true;
    canvasContainer.hidden = false;

    clearStatus();
    startRenderLoop();
  } catch (error) {
    showError(`Failed to load bundle: ${error.message}`);
    clearStatus();
    resetCanvasUi();
  }
}

function startRenderLoop() {
  stopRenderLoop();

  function tick(timestamp) {
    if (!webHost) return;

    if (lastTimestamp === 0) {
      lastTimestamp = timestamp;
    }

    try {
      webHost.frame(timestamp);
      const stats = webHost.stats() || {};
      if (typeof stats.fps === 'number') {
        slideFps.textContent = `${Math.round(stats.fps)} FPS`;
      }
    } catch (error) {
      console.error('[vzglyd] frame error', error);
      showError(`Frame error: ${error.message}`);
      stopRenderLoop();
      return;
    }

    lastTimestamp = timestamp;
    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);
}

function stopRenderLoop() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  lastTimestamp = 0;
}

function teardownHost() {
  stopRenderLoop();
  if (webHost) {
    try {
      webHost.teardown();
    } catch (error) {
      console.warn('[vzglyd] teardown failed', error);
    }
    webHost = null;
  }
}

function installCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const targetId = button.dataset.target;
      const text = document.getElementById(targetId)?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied!';
        button.classList.add('copied');
        setTimeout(() => {
          button.textContent = 'Copy';
          button.classList.remove('copied');
        }, 2000);
      } catch {
        showError('Clipboard copy failed');
      }
    });
  });
}

function installDropHandlers() {
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.vzglyd')) {
      showError('Please drop a .vzglyd file');
      return;
    }
    loadBundleFile(file);
  });

  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropZone.querySelector('.file-label')?.addEventListener('click', (event) => {
    event.preventDefault();
    fileInput.click();
  });

  fileInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    loadBundleFile(file);
  });
}

function installUiHandlers() {
  backBtn.addEventListener('click', async () => {
    teardownHost();
    resetCanvasUi();
    await initHost();
  });

  errorDismiss.addEventListener('click', hideError);
}

async function boot() {
  installCopyButtons();
  installDropHandlers();
  installUiHandlers();
  await initHost();
}

boot();
