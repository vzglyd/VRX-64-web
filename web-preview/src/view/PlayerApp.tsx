import type { ReactElement } from 'react';

const markup = String.raw`
<div id="app" class="view-app">
    <main class="view-shell" aria-label="Slide player">
      <div class="view-trace-controls" aria-label="Trace capture controls">
        <span id="view-trace-status" class="view-trace-status">Trace idle</span>
        <button id="view-trace-toggle" class="view-trace-button" type="button">Start Trace</button>
        <a class="view-trace-link" href="https://ui.perfetto.dev/" target="_blank" rel="noopener">Open Perfetto</a>
      </div>
      <div class="view-stage">
        <canvas id="view-canvas" class="view-canvas" width="640" height="480"></canvas>
      </div>
    </main>

    <div id="view-overlay" class="view-overlay" hidden>
      <div class="view-overlay-card">
        <p id="view-overlay-kicker" class="eyebrow">Browser player</p>
        <h1 id="view-overlay-title">Loading player</h1>
        <p id="view-overlay-text" class="subtitle"></p>
      </div>
    </div>
  </div>
`;

export function PlayerApp(): ReactElement {
  return <div dangerouslySetInnerHTML={{ __html: markup }} />;
}
