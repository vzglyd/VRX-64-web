import {
  fetchBundleFromRepo,
  loadPlaylistFromRepo,
} from './js/playlist_repo.js';
import {
  buildPlayableSchedule,
  nextScheduleIndex,
  normalizeStartIndex,
} from './js/view_player.js';

const REPO_STORAGE_KEY = 'vzglyd.shared_repo_url';
const RENDER_WIDTH = 640;
const RENDER_HEIGHT = 480;

const overlay = document.getElementById('view-overlay');
const overlayKicker = document.getElementById('view-overlay-kicker');
const overlayTitle = document.getElementById('view-overlay-title');
const overlayText = document.getElementById('view-overlay-text');

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

class HostSlot {
  constructor(canvas, size) {
    this.canvas = canvas;
    sizeCanvas(this.canvas, size);
    this.host = null;
    this.entry = null;
    this.bundleUrl = '';
    this.loadToken = 0;
  }

  async ensureHost() {
    await ensureRuntime();
    if (!this.host) {
      this.host = new WebHostCtor(this.canvas, {
        networkPolicy: 'any_https',
      });
    }
  }

  async load(entry, bundle) {
    const token = ++this.loadToken;
    await this.ensureHost();
    await this.host.loadBundle(bundle.bytes, {
      params: entry.params ?? null,
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
}

const playerHost = new HostSlot(document.getElementById('view-canvas'), {
  width: RENDER_WIDTH,
  height: RENDER_HEIGHT,
});

function sizeCanvas(canvas, size) {
  canvas.width = size.width;
  canvas.height = size.height;
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
    startLoop();
  } catch (error) {
    if (sessionToken !== state.sessionToken) {
      return;
    }
    failPlayback(error);
  }
}

function boot() {
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
