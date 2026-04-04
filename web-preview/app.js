import {
  describePlaylistEntry,
  fetchBundleFromRepo,
  loadPlaylistFromRepo,
} from './js/playlist_repo.js';

const REPO_STORAGE_KEY = 'vzglyd.shared_repo_url';

const repoForm = document.getElementById('repo-form');
const repoUrlInput = document.getElementById('repo-url');
const repoSummary = document.getElementById('repo-summary');
const playlistShell = document.getElementById('playlist-shell');
const playlistMeta = document.getElementById('playlist-meta');
const playlistList = document.getElementById('playlist-list');
const playlistEmpty = document.getElementById('playlist-empty');
const localBundleBtn = document.getElementById('local-bundle-btn');
const fileInput = document.getElementById('file-input');
const canvasShell = document.getElementById('canvas-shell');
const canvas = document.getElementById('render-canvas');
const slideName = document.getElementById('slide-name');
const slideFps = document.getElementById('slide-fps');
const slideSource = document.getElementById('slide-source');
const backBtn = document.getElementById('back-btn');
const activeSlideLink = document.getElementById('active-slide-link');
const statusBar = document.getElementById('status-bar');
const statusSpinner = document.getElementById('status-spinner');
const statusText = document.getElementById('status-text');
const errorBox = document.getElementById('error-box');
const errorText = document.getElementById('error-text');
const errorDismiss = document.getElementById('error-dismiss');
const noWebgpu = document.getElementById('no-webgpu');
const fileOriginWarning = document.getElementById('file-origin-warning');
const openEditorLink = document.getElementById('open-editor-link');
const openPlayerLink = document.getElementById('open-player-link');

let webHost = null;
let rafId = null;
let lastTimestamp = 0;
let autoTracePosted = false;

const state = {
  repo: null,
  currentSlideIndex: null,
  currentBundleUrl: null,
};

function parseTraceFlag(value) {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function traceConfigFromUrl(pageLabel) {
  const url = new URL(window.location.href);
  const traceEnabled = parseTraceFlag(url.searchParams.get('trace'))
    || url.searchParams.has('traceCollector')
    || url.searchParams.has('traceSession');
  if (!traceEnabled) {
    return null;
  }

  return {
    enabled: true,
    label: url.searchParams.get('traceLabel') ?? pageLabel,
    sessionId: url.searchParams.get('traceSession') ?? undefined,
    collectorUrl: url.searchParams.get('traceCollector') ?? undefined,
  };
}

const traceConfig = traceConfigFromUrl('web-preview');

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
  errorText.textContent = '';
}

function resetCanvasUi() {
  canvasShell.hidden = true;
  slideName.textContent = 'No slide loaded';
  slideSource.textContent = '';
  slideFps.textContent = '';
  activeSlideLink.hidden = true;
  activeSlideLink.removeAttribute('href');
}

function updateCrossLinks() {
  const editorUrl = new URL('./editor.html', window.location.href);
  const playerUrl = new URL('./view.html', window.location.href);
  if (state.repo?.repoBaseUrl) {
    editorUrl.searchParams.set('repo', state.repo.repoBaseUrl);
    playerUrl.searchParams.set('repo', state.repo.repoBaseUrl);
  }
  if (traceConfig?.enabled) {
    playerUrl.searchParams.set('trace', '1');
    if (traceConfig.sessionId) {
      playerUrl.searchParams.set('traceSession', traceConfig.sessionId);
    }
    if (traceConfig.collectorUrl) {
      playerUrl.searchParams.set('traceCollector', traceConfig.collectorUrl);
    }
    if (traceConfig.label) {
      playerUrl.searchParams.set('traceLabel', traceConfig.label);
    }
  }
  openEditorLink.href = editorUrl.toString();
  openPlayerLink.href = playerUrl.toString();
}

function syncLocation() {
  const url = new URL(window.location.href);
  if (state.repo?.repoBaseUrl) {
    url.searchParams.set('repo', state.repo.repoBaseUrl);
  } else {
    url.searchParams.delete('repo');
  }

  if (state.repo?.repoBaseUrl && Number.isInteger(state.currentSlideIndex)) {
    url.searchParams.set('slide', String(state.currentSlideIndex));
  } else {
    url.searchParams.delete('slide');
  }

  window.history.replaceState({}, '', url);
  updateCrossLinks();
}

function countEnabledSlides(slides) {
  return slides.filter((entry) => entry.enabled !== false).length;
}

function describeEntryBadges(entry) {
  const details = describePlaylistEntry(entry, state.repo?.playlist.defaults ?? {});
  const badges = [];
  if (!details.enabled) badges.push('disabled');
  if (details.durationSeconds != null) badges.push(`${details.durationSeconds}s`);
  if (details.transitionIn) badges.push(`in:${details.transitionIn}`);
  if (details.transitionOut) badges.push(`out:${details.transitionOut}`);
  if (details.hasParams) badges.push('params');
  return badges;
}

function renderPlaylist() {
  playlistList.replaceChildren();

  if (!state.repo) {
    playlistShell.hidden = true;
    return;
  }

  const { playlist, playlistUrl } = state.repo;
  playlistShell.hidden = false;
  playlistMeta.textContent = `${playlist.slides.length} entr${playlist.slides.length === 1 ? 'y' : 'ies'} • ${countEnabledSlides(playlist.slides)} enabled • ${playlistUrl}`;
  playlistEmpty.hidden = playlist.slides.length > 0;

  for (const [index, entry] of playlist.slides.entries()) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'playlist-item';

    if (index === state.currentSlideIndex) {
      item.classList.add('is-active');
    }
    if (entry.enabled === false) {
      item.classList.add('is-disabled');
    }

    const title = document.createElement('span');
    title.className = 'playlist-item-title';
    title.textContent = entry.path;

    const badges = document.createElement('span');
    badges.className = 'playlist-item-badges';
    for (const value of describeEntryBadges(entry)) {
      const badge = document.createElement('span');
      badge.className = 'badge-pill';
      badge.textContent = value;
      badges.append(badge);
    }

    const params = document.createElement('span');
    params.className = 'playlist-item-detail';
    if (entry.params !== undefined) {
      params.textContent = `params ${JSON.stringify(entry.params)}`;
    } else {
      params.textContent = index === state.currentSlideIndex
        ? 'Loaded into preview'
        : 'Click to fetch and open this bundle';
    }

    item.append(title, badges, params);
    item.addEventListener('click', () => {
      void loadPlaylistEntry(index);
    });
    playlistList.append(item);
  }
}

async function checkWebGpuSupport() {
  if (!navigator.gpu) {
    noWebgpu.hidden = false;
    return false;
  }

  if (window.location.protocol === 'file:') {
    fileOriginWarning.hidden = false;
    return false;
  }

  const adapter =
    await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) ??
    await navigator.gpu.requestAdapter() ??
    await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });

  if (!adapter) {
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
      trace: traceConfig,
    });

    clearStatus();
    return true;
  } catch (error) {
    showError(`Failed to initialize runtime: ${error.message}`);
    return false;
  }
}

function currentTraceMetadata() {
  const currentEntry = Number.isInteger(state.currentSlideIndex)
    ? state.repo?.playlist?.slides?.[state.currentSlideIndex]
    : null;
  return {
    page: 'preview',
    repo: state.repo?.repoBaseUrl ?? '',
    slide_index: state.currentSlideIndex ?? '',
    slide_path: currentEntry?.path ?? '',
    bundle_url: state.currentBundleUrl ?? '',
  };
}

function installTraceTools() {
  if (!traceConfig?.enabled) {
    return;
  }

  window.vzglydTrace = {
    exportTrace() {
      return webHost?.exportTrace?.() ?? null;
    },
    postTrace(extraMetadata = {}) {
      if (!webHost?.postTrace) {
        return Promise.resolve(false);
      }
      return webHost.postTrace({
        ...currentTraceMetadata(),
        ...extraMetadata,
      });
    },
  };

  const flushTrace = () => {
    if (autoTracePosted || !webHost?.postTrace) {
      return;
    }
    autoTracePosted = true;
    void webHost.postTrace(currentTraceMetadata());
  };

  window.addEventListener('pagehide', flushTrace);
  window.addEventListener('beforeunload', flushTrace);
}

async function loadBundleBytes(bytes, label, bundleUrl = null, params = null) {
  if (!webHost) {
    showError('Host is not initialized');
    return;
  }

  try {
    hideError();
    setStatus(`Loading ${label}...`, true);

    await webHost.loadBundle(bytes, {
      logLoadSummary: true,
      params,
    });
    const stats = webHost.stats() || {};

    slideName.textContent = stats.slideName || stats.manifestName || label;
    slideSource.textContent = bundleUrl ?? label;
    slideFps.textContent = '';
    canvasShell.hidden = false;

    if (bundleUrl) {
      activeSlideLink.href = bundleUrl;
      activeSlideLink.hidden = false;
    } else {
      activeSlideLink.hidden = true;
    }

    clearStatus();
    startRenderLoop();
  } catch (error) {
    showError(`Failed to load bundle: ${error.message}`);
    clearStatus();
    resetCanvasUi();
    throw error;
  }
}

async function loadPlaylistEntry(index) {
  if (!state.repo) {
    showError('Load a slides repo first');
    return;
  }

  const entry = state.repo.playlist.slides[index];
  if (!entry) {
    showError(`Playlist entry ${index} does not exist`);
    return;
  }

  try {
    hideError();
    setStatus(`Fetching ${entry.path}...`, true);
    const { bundleUrl, bytes } = await fetchBundleFromRepo(state.repo.repoBaseUrl, entry.path);
    await loadBundleBytes(bytes, entry.path, bundleUrl, entry.params ?? null);
    state.currentSlideIndex = index;
    state.currentBundleUrl = bundleUrl;
    syncLocation();
    renderPlaylist();
  } catch (error) {
    if (errorBox.hidden) {
      showError(error.message);
    }
    clearStatus();
  }
}

async function loadLocalBundle(file) {
  if (!file.name.endsWith('.vzglyd')) {
    showError('Please choose a .vzglyd file');
    return;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  state.currentSlideIndex = null;
  state.currentBundleUrl = null;
  try {
    syncLocation();
    await loadBundleBytes(bytes, file.name);
    renderPlaylist();
  } catch (error) {
    if (errorBox.hidden) {
      showError(error.message);
    }
    clearStatus();
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

function unloadCurrentSlide(clearSelection = false) {
  stopRenderLoop();
  if (webHost) {
    try {
      webHost.teardown();
    } catch (error) {
      console.warn('[vzglyd] teardown failed', error);
    }
  }

  if (clearSelection) {
    state.currentSlideIndex = null;
    state.currentBundleUrl = null;
    syncLocation();
    renderPlaylist();
  }

  resetCanvasUi();
}

function setRepoSummary() {
  if (!state.repo) {
    repoSummary.textContent = 'Connect a static slide root to browse bundles from playlist.json.';
    return;
  }

  repoSummary.textContent = `Loaded ${state.repo.playlistUrl}`;
}

async function connectRepo(autoSlideIndex = null) {
  try {
    hideError();
    setStatus('Fetching playlist.json...', true);

    const repo = await loadPlaylistFromRepo(repoUrlInput.value);
    unloadCurrentSlide();
    state.currentSlideIndex = null;
    state.currentBundleUrl = null;
    state.repo = repo;
    repoUrlInput.value = repo.repoBaseUrl;
    window.localStorage.setItem(REPO_STORAGE_KEY, repo.repoBaseUrl);
    setRepoSummary();
    renderPlaylist();
    syncLocation();
    clearStatus();

    if (Number.isInteger(autoSlideIndex) && repo.playlist.slides[autoSlideIndex]) {
      await loadPlaylistEntry(autoSlideIndex);
      return;
    }

    setStatus(`Playlist ready. Select a bundle from ${repo.playlist.slides.length} entr${repo.playlist.slides.length === 1 ? 'y' : 'ies'}.`, false);
  } catch (error) {
    showError(error.message);
    clearStatus();
  }
}

function installCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const targetId = button.dataset.target;
      const text = document.getElementById(targetId)?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
        button.classList.add('copied');
        window.setTimeout(() => {
          button.textContent = 'Copy';
          button.classList.remove('copied');
        }, 1600);
      } catch {
        showError('Clipboard copy failed');
      }
    });
  });
}

function installHandlers() {
  repoForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void connectRepo();
  });

  localBundleBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void loadLocalBundle(file);
    event.target.value = '';
  });

  backBtn.addEventListener('click', () => {
    unloadCurrentSlide(true);
  });

  errorDismiss.addEventListener('click', hideError);
}

async function boot() {
  installTraceTools();
  setRepoSummary();
  resetCanvasUi();
  updateCrossLinks();
  installCopyButtons();
  installHandlers();

  if (!(await initHost())) {
    return;
  }

  const url = new URL(window.location.href);
  const requestedRepo = url.searchParams.get('repo') ?? window.localStorage.getItem(REPO_STORAGE_KEY);
  const requestedSlide = Number.parseInt(url.searchParams.get('slide') ?? '', 10);

  if (requestedRepo) {
    repoUrlInput.value = requestedRepo;
    await connectRepo(Number.isInteger(requestedSlide) ? requestedSlide : null);
  } else {
    setStatus('Ready. Connect a static slide root or load a local .vzglyd bundle.', false);
  }
}

void boot();
