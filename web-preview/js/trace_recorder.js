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
    this._startMs = nowMs();
    this._events = [];
    this._threads = new Map();
    this._nextTid = 1;
    this._nextSpanId = 1;
    this._activeSpans = new Map();
    this._metadata = {
      host_kind: config.hostKind ?? 'web',
      label: config.label ?? 'web-session',
      session_id: config.sessionId ?? generateSessionId(),
    };
    this._collectorUrl = config.collectorUrl ?? null;
    this._observer = null;

    this._events.push({
      name: 'process_name',
      cat: '__metadata',
      ph: 'M',
      ts: 0,
      pid: 1,
      tid: 0,
      args: { name: `vzglyd-${this._metadata.host_kind}` },
    });
  }

  get enabled() {
    return this._enabled;
  }

  get sessionId() {
    return this._metadata.session_id;
  }

  setMetadata(key, value) {
    this._metadata[key] = String(value);
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
    if (!this._enabled) return spanId;
    const tid = this._resolveThread(thread);
    this._activeSpans.set(spanId, { tid, category, name });
    this._events.push({
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
    if (!this._enabled) return;
    const active = this._activeSpans.get(spanId);
    if (!active) return;
    this._activeSpans.delete(spanId);
    this._events.push({
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
    if (!this._enabled) return;
    this._events.push({
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
    if (!this._enabled) return;
    this._events.push({
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

  async postToCollector(extraMetadata = {}) {
    if (!this._enabled || !this._collectorUrl) {
      return false;
    }

    const payload = {
      ...this.exportTrace(),
      metadata: {
        ...this._metadata,
        ...toStringMap(extraMetadata),
      },
    };
    const encoded = JSON.stringify(payload);

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([encoded], { type: 'application/json' });
        if (navigator.sendBeacon(this._collectorUrl, blob)) {
          return true;
        }
      } catch {
        // Fall back to fetch below.
      }
    }

    if (typeof fetch !== 'function') {
      return false;
    }

    const response = await fetch(this._collectorUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: encoded,
      keepalive: true,
    });
    return response.ok;
  }

  _resolveThread(name) {
    if (this._threads.has(name)) {
      return this._threads.get(name);
    }

    const tid = this._nextTid++;
    this._threads.set(name, tid);
    this._events.push({
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

  _toUs(atMs) {
    return Math.max(0, Math.round((atMs - this._startMs) * 1000));
  }
}

export function createTraceRecorder(config = {}) {
  return new TraceRecorder(config);
}

export { TraceRecorder };
