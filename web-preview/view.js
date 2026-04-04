import {
  fetchBundleFromRepo,
  loadPlaylistFromRepo,
} from './js/playlist_repo.js';
import {
  buildPlayableSchedule,
  nextScheduleIndex,
  normalizeStartIndex,
} from './js/view_player.js';
import { syncCanvasToContainer } from './js/canvas_sizing.js';

const REPO_STORAGE_KEY = 'vzglyd.shared_repo_url';

const overlay = document.getElementById('view-overlay');
const overlayKicker = document.getElementById('view-overlay-kicker');
const overlayTitle = document.getElementById('view-overlay-title');
const overlayText = document.getElementById('view-overlay-text');
const traceToggle = document.getElementById('view-trace-toggle');
const traceStatus = document.getElementById('view-trace-status');

let runtimeModulePromise = null;
let WebHostCtor = null;
let rafId = null;

const state = {
  repo: null,
  schedule: [],
  currentIndex: 0,
  slideStartedAtMs: 0,
  advancing: false,
  sessionToken: 0,
};
let autoTraceStarted = false;

function parseTraceFlag(value) {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function traceConfigFromUrl(pageLabel) {
  const url = new URL(window.location.href);
  return {
    enabled: true,
    label: url.searchParams.get('traceLabel') ?? pageLabel,
    autoStart: parseTraceFlag(url.searchParams.get('trace')),
  };
}

const traceConfig = traceConfigFromUrl('web-view');

class HostSlot {
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.host = null;
    this.entry = null;
    this.bundleUrl = '';
    this.loadToken = 0;
    this.resizeObserver = null;

    this.syncSize();
    this.bindResize();
  }

  async ensureHost() {
    await ensureRuntime();
    if (!this.host) {
      this.host = new WebHostCtor(this.canvas, {
        networkPolicy: 'any_https',
        trace: traceConfig,
      });
    }
  }

  async load(entry, bundle) {
    const token = ++this.loadToken;
    await this.ensureHost();
    await this.host.loadBundle(bundle.bytes, {
      params: entry.params ?? null,
      slideIndex: state.currentIndex,
      slidePath: entry.path ?? '',
    });

    if (token !== this.loadToken) {
      return;
    }

    this.entry = entry;
    this.bundleUrl = bundle.bundleUrl;
  }

  frame(timestampMs) {
    if (!this.host) {
      return;
    }

    this.host.frame(timestampMs);
  }

  teardown() {
    this.loadToken += 1;
    this.entry = null;
    this.bundleUrl = '';

    if (!this.host) {
      return;
    }

    try {
      this.host.teardown();
    } catch (error) {
      console.warn('[vzglyd] slot teardown failed', error);
    }

    this.host = null;
  }

  syncSize() {
    syncCanvasToContainer(this.canvas, this.stage);
  }

  bindResize() {
    const update = () => this.syncSize();
    window.addEventListener('resize', update, { passive: true });

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => update());
      this.resizeObserver.observe(this.stage);
    }
  }
}

const playerHost = new HostSlot(
  document.getElementById('view-canvas'),
  document.querySelector('.view-stage'),
);

function currentTraceMetadata() {
  const currentEntry = state.schedule[state.currentIndex];
  return {
    page: 'view',
    repo: state.repo?.repoBaseUrl ?? '',
    slide_index: state.currentIndex,
    slide_path: currentEntry?.path ?? '',
    bundle_url: playerHost.bundleUrl,
  };
}

function sanitizeTraceName(value) {
  const sanitized = String(value ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'session';
}

function buildTraceFilename() {
  const currentEntry = state.schedule[state.currentIndex];
  const source = currentEntry?.path || playerHost.host?.stats?.()?.slideName || 'session';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `vzglyd-web-${sanitizeTraceName(source)}-${timestamp}.perfetto.json`;
}

function syncTraceUi(message = null) {
  const capturing = Boolean(playerHost.host?.stats?.()?.traceCapturing);
  traceToggle.textContent = capturing ? 'Stop & Download' : 'Start Trace';
  traceStatus.textContent = message ?? (capturing ? 'Capturing trace…' : 'Trace idle');
}

async function toggleTraceCapture() {
  try {
    await playerHost.ensureHost();
    const capturing = Boolean(playerHost.host?.stats?.()?.traceCapturing);
    if (!capturing) {
      const started = playerHost.host?.startTraceCapture?.(currentTraceMetadata()) ?? false;
      syncTraceUi(started ? 'Capturing trace…' : 'Trace unavailable');
      return;
    }

    playerHost.host?.stopTraceCapture?.(currentTraceMetadata());
    const filename = buildTraceFilename();
    const downloaded = playerHost.host?.downloadTrace?.(filename) ?? false;
    syncTraceUi(downloaded ? `Downloaded ${filename}` : 'Trace ready');
  } catch (error) {
    console.error('[vzglyd] trace capture failed', error);
    syncTraceUi('Trace capture failed');
  }
}

function installTraceTools() {
  syncTraceUi();
  traceToggle.addEventListener('click', () => {
    void toggleTraceCapture();
  });

  window.vzglydTrace = {
    startCapture(extraMetadata = {}) {
      return playerHost.host?.startTraceCapture?.({
        ...currentTraceMetadata(),
        ...extraMetadata,
      }) ?? false;
    },
    stopCapture(extraMetadata = {}) {
      return playerHost.host?.stopTraceCapture?.({
        ...currentTraceMetadata(),
        ...extraMetadata,
      }) ?? false;
    },
    exportTrace() {
      return playerHost.host?.exportTrace?.() ?? null;
    },
    downloadTrace(filename = buildTraceFilename()) {
      return playerHost.host?.downloadTrace?.(filename) ?? false;
    },
  };
}

function setOverlay(kicker, title, text, tone = 'info') {
  overlay.hidden = false;
  overlay.dataset.tone = tone;
  overlayKicker.textContent = kicker;
  overlayTitle.textContent = title;
  overlayText.textContent = text;
}

function hideOverlay() {
  overlay.hidden = true;
  delete overlay.dataset.tone;
}

function stopLoop() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function resetPlaybackState() {
  stopLoop();
  state.sessionToken += 1;
  state.repo = null;
  state.schedule = [];
  state.currentIndex = 0;
  state.slideStartedAtMs = 0;
  state.advancing = false;
  playerHost.teardown();
  syncTraceUi();
}

async function ensureRuntime() {
  if (!runtimeModulePromise) {
    runtimeModulePromise = (async () => {
      const runtime = await import('./pkg/vzglyd_web.js');
      await runtime.default();
      WebHostCtor = runtime.WebHost;
    })();
  }

  await runtimeModulePromise;
}

async function fetchBundle(entry) {
  return fetchBundleFromRepo(state.repo.repoBaseUrl, entry.path);
}

function failPlayback(error) {
  console.error('[vzglyd] playback error', error);
  state.advancing = false;
  setOverlay(
    'Browser player',
    'Playback error',
    error instanceof Error ? error.message : String(error),
    'error',
  );
  stopLoop();
}

async function advanceSlide() {
  if (state.advancing || state.schedule.length <= 1) {
    return;
  }

  const nextIndex = nextScheduleIndex(state.currentIndex, state.schedule.length);
  const nextEntry = state.schedule[nextIndex];
  const sessionToken = state.sessionToken;

  state.advancing = true;

  try {
    const bundle = await fetchBundle(nextEntry);
    if (sessionToken !== state.sessionToken) {
      return;
    }

    await playerHost.load(nextEntry, bundle);
    if (sessionToken !== state.sessionToken) {
      return;
    }

    state.currentIndex = nextIndex;
    state.slideStartedAtMs = performance.now();
  } catch (error) {
    if (sessionToken !== state.sessionToken) {
      return;
    }
    failPlayback(error);
  } finally {
    if (sessionToken === state.sessionToken) {
      state.advancing = false;
    }
  }
}

function maybeAdvanceSlide(timestampMs) {
  if (state.advancing || state.schedule.length <= 1) {
    return;
  }

  const currentEntry = state.schedule[state.currentIndex];
  const elapsedMs = timestampMs - state.slideStartedAtMs;
  if (elapsedMs < currentEntry.durationSeconds * 1000) {
    return;
  }

  void advanceSlide();
}

function tick(timestampMs) {
  try {
    if (!state.advancing) {
      playerHost.frame(timestampMs);
      maybeAdvanceSlide(timestampMs);
    }
  } catch (error) {
    failPlayback(error);
    return;
  }

  rafId = requestAnimationFrame(tick);
}

function startLoop() {
  stopLoop();
  rafId = requestAnimationFrame(tick);
}

async function bootPlayer(repoBaseUrl, requestedStartIndex) {
  resetPlaybackState();
  const sessionToken = state.sessionToken;
  setOverlay('Browser player', 'Loading player', 'Fetching playlist.json...', 'info');

  try {
    await ensureRuntime();
    await playerHost.ensureHost();
    if (traceConfig.autoStart && !autoTraceStarted) {
      playerHost.host?.startTraceCapture?.({
        ...currentTraceMetadata(),
        trigger: 'auto',
      });
      autoTraceStarted = true;
      syncTraceUi('Capturing trace…');
    }

    const repo = await loadPlaylistFromRepo(repoBaseUrl);
    if (sessionToken !== state.sessionToken) {
      return;
    }

    const schedule = buildPlayableSchedule(repo.playlist);
    if (schedule.length === 0) {
      throw new Error('playlist.json does not contain any enabled slides');
    }

    state.repo = repo;
    state.schedule = schedule;
    state.currentIndex = normalizeStartIndex(requestedStartIndex, schedule.length);

    try {
      window.localStorage.setItem(REPO_STORAGE_KEY, repo.repoBaseUrl);
    } catch {
      // Ignore storage failures in private or locked-down browser contexts.
    }

    const currentEntry = schedule[state.currentIndex];
    const currentBundle = await fetchBundle(currentEntry);
    if (sessionToken !== state.sessionToken) {
      return;
    }

    await playerHost.load(currentEntry, currentBundle);
    if (sessionToken !== state.sessionToken) {
      return;
    }

    const now = performance.now();
    playerHost.frame(now);
    state.slideStartedAtMs = now;

    hideOverlay();
    syncTraceUi();
    startLoop();
  } catch (error) {
    if (sessionToken !== state.sessionToken) {
      return;
    }
    failPlayback(error);
  }
}

function boot() {
  installTraceTools();
  const url = new URL(window.location.href);
  let savedRepo = null;
  try {
    savedRepo = window.localStorage.getItem(REPO_STORAGE_KEY);
  } catch {
    savedRepo = null;
  }
  const repo = url.searchParams.get('repo') ?? savedRepo;
  const startIndex = url.searchParams.get('slide');

  if (!repo) {
    setOverlay(
      'Browser player',
      'Missing repo',
      'Open this page with ?repo=<slide-root-url> or load a repo in the editor first.',
      'warning',
    );
    return;
  }

  void bootPlayer(repo, startIndex);
}

boot();
