import { VzglydSidecarHost } from './wasm-host.js';

const sleepBuffer = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4) : null;
const sleepView = sleepBuffer ? new Int32Array(sleepBuffer) : null;

function blockingSleep(ms) {
  if (!sleepView || !Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(sleepView, 0, 0, ms);
}

self.onmessage = async (event) => {
  const { data } = event;
  if (data?.type !== 'init') return;

  try {
    const host = new VzglydSidecarHost({
      channelState: {
        latest: null,
        dirty: false,
        active: true,
      },
      networkPolicy: data.networkPolicy ?? 'any_https',
      endpointMap: data.endpointMap ?? {},
      blockingSleep: sleepView ? blockingSleep : null,
      onChannelPush(bytes) {
        self.postMessage({ type: 'channel_push', bytes }, [bytes.buffer]);
      },
      onLog(message) {
        self.postMessage({ type: 'log', message });
      },
      onTrace(eventPayload) {
        self.postMessage({ type: 'trace', event: eventPayload });
      },
    });

    const sidecarModule = await WebAssembly.instantiate(data.wasmBytes, host.buildImports());
    host.setInstance(sidecarModule.instance);
    host.configureParams(data.paramsBytes ?? null);
    self.postMessage({ type: 'ready' });
    host.run();
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
