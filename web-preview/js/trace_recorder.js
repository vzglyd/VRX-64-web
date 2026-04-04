const DEFAULT_MAX_EVENTS = 50000;

function generateSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function toStringMap(input = {}) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  );
}

class TraceRecorder {
  constructor(config = {}) {
    this._enabled = config.enabled !== false;
    this._metadata = {
      host_kind: config.hostKind ?? 'web',
      label: config.label ?? 'web-session',
      session_id: config.sessionId ?? generateSessionId(),
    };
    this._maxEvents = Math.max(1024, Number(config.maxEvents) || DEFAULT_MAX_EVENTS);
    this._observer = null;
    this._capturing = false;
    this._initializeTrace();

    if (config.autoStart) {
      this.startCapture();
    }
  }

  get enabled() {
    return this._enabled;
  }

  get sessionId() {
    return this._metadata.session_id;
  }

  get capturing() {
    return this._capturing;
  }

  setMetadata(key, value) {
    this._metadata[key] = String(value);
  }

  startCapture(extraMetadata = {}) {
    if (!this._enabled) {
      return false;
    }
    this._initializeTrace();
    this._applyMetadata(extraMetadata);
    this._capturing = true;
    return true;
  }

  stopCapture(extraMetadata = {}) {
    if (!this._enabled) {
      return false;
    }

    this._applyMetadata(extraMetadata);
    if (!this._capturing) {
      return false;
    }

    const stoppedAtMs = nowMs();
    for (const [spanId, active] of Array.from(this._activeSpans.entries())) {
      this._activeSpans.delete(spanId);
      this._recordEvent({
        name: active.name,
        cat: active.category,
        ph: 'E',
        ts: this._toUs(stoppedAtMs),
        pid: 1,
        tid: active.tid,
        args: { status: 'stopped' },
      });
    }

    if (this._droppedEvents > 0) {
      this.setMetadata('dropped_events', this._droppedEvents);
    }
    this._capturing = false;
    return true;
  }

  bindLongTasks(thread = 'web.main') {
    if (!this._enabled || this._observer || typeof PerformanceObserver !== 'function') {
      return;
    }

    try {
      this._observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.completeAt(
            thread,
            'browser.longtask',
            'longtask',
            entry.startTime,
            entry.duration,
            {
              name: entry.name,
            },
          );
        }
      });
      this._observer.observe({ entryTypes: ['longtask'] });
    } catch {
      this._observer = null;
    }
  }

  beginSpan(thread, category, name, args = {}) {
    const spanId = this._nextSpanId++;
    return this.beginSpanWithId(spanId, thread, category, name, args);
  }

  beginSpanWithId(spanId, thread, category, name, args = {}, atMs = nowMs()) {
    if (!this._capturing) return spanId;
    const tid = this._resolveThread(thread);
    this._activeSpans.set(spanId, { tid, category, name });
    this._recordEvent({
      name,
      cat: category,
      ph: 'B',
      ts: this._toUs(atMs),
      pid: 1,
      tid,
      args: toStringMap(args),
    });
    return spanId;
  }

  endSpan(spanId, args = {}, atMs = nowMs()) {
    if (!this._capturing) return;
    const active = this._activeSpans.get(spanId);
    if (!active) return;
    this._activeSpans.delete(spanId);
    this._recordEvent({
      name: active.name,
      cat: active.category,
      ph: 'E',
      ts: this._toUs(atMs),
      pid: 1,
      tid: active.tid,
      args: toStringMap(args),
    });
  }

  instant(thread, category, name, args = {}, atMs = nowMs()) {
    if (!this._capturing) return;
    this._recordEvent({
      name,
      cat: category,
      ph: 'i',
      ts: this._toUs(atMs),
      pid: 1,
      tid: this._resolveThread(thread),
      args: toStringMap(args),
    });
  }

  complete(thread, category, name, durationMs, args = {}, endMs = nowMs()) {
    this.completeAt(thread, category, name, endMs - durationMs, durationMs, args);
  }

  completeAt(thread, category, name, startMs, durationMs, args = {}) {
    if (!this._capturing) return;
    this._recordEvent({
      name,
      cat: category,
      ph: 'X',
      ts: this._toUs(startMs),
      pid: 1,
      tid: this._resolveThread(thread),
      dur: Math.max(0, Math.round(durationMs * 1000)),
      args: toStringMap(args),
    });
  }

  exportTrace() {
    return {
      sessionId: this.sessionId,
      metadata: { ...this._metadata },
      traceEvents: [...this._events],
      displayTimeUnit: 'ms',
    };
  }

  downloadTrace(filename = 'vzglyd-web-trace.perfetto.json') {
    if (typeof Blob === 'undefined' || typeof document === 'undefined' || typeof URL === 'undefined') {
      return false;
    }

    const blob = new Blob([JSON.stringify(this.exportTrace(), null, 2)], {
      type: 'application/json',
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    return true;
  }

  _applyMetadata(extraMetadata = {}) {
    for (const [key, value] of Object.entries(toStringMap(extraMetadata))) {
      this.setMetadata(key, value);
    }
  }

  _initializeTrace() {
    this._startMs = nowMs();
    this._events = [];
    this._threads = new Map();
    this._nextTid = 1;
    this._nextSpanId = 1;
    this._activeSpans = new Map();
    this._droppedEvents = 0;
    this._recordEvent({
      name: 'process_name',
      cat: '__metadata',
      ph: 'M',
      ts: 0,
      pid: 1,
      tid: 0,
      args: { name: `vzglyd-${this._metadata.host_kind}` },
    });
  }

  _resolveThread(name) {
    if (this._threads.has(name)) {
      return this._threads.get(name);
    }

    const tid = this._nextTid++;
    this._threads.set(name, tid);
    this._recordEvent({
      name: 'thread_name',
      cat: '__metadata',
      ph: 'M',
      ts: 0,
      pid: 1,
      tid,
      args: { name },
    });
    return tid;
  }

  _recordEvent(event) {
    if (this._events.length >= this._maxEvents) {
      this._droppedEvents += 1;
      return;
    }
    this._events.push(event);
  }

  _toUs(atMs) {
    return Math.max(0, Math.round((atMs - this._startMs) * 1000));
  }
}

export function createTraceRecorder(config = {}) {
  return new TraceRecorder(config);
}

export { TraceRecorder };
