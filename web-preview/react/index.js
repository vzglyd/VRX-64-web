import{_ as e,i as t,n,o as r,v as i,y as a}from"./chunks/playlist_repo-sMAodyh6.js";import{t as o}from"./chunks/preload-helper-iChaxtTA.js";var s=a(),c=i(),l=e(),u=String.raw`
<div id="app">
    <header class="hero">
      <div>
        <p class="eyebrow">Static slide root preview</p>
        <h1>vzglyd preview</h1>
        <p class="subtitle">
          Connect any static slide root that serves a required <code>playlist.json</code> and
          repo-root-relative <code>.vzglyd</code> bundles.
        </p>
      </div>
      <div class="hero-actions">
        <a id="open-player-link" class="ghost-link" href="view.html">Open player</a>
        <a id="open-editor-link" class="ghost-link" href="editor.html">Open repo editor</a>
        <a class="ghost-link" href="gpu-test.html">GPU check</a>
      </div>
    </header>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Slides repo</h2>
          <p class="hint">
            Example base URLs: <code>http://localhost:8081/</code> or
            <code>https://rodgerbenham.github.io/vzglyd/</code>.
          </p>
        </div>
      </div>

      <form id="repo-form" class="repo-form">
        <label class="field grow">
          <span>Repo base URL</span>
          <input id="repo-url" type="url" placeholder="https://rodgerbenham.github.io/vzglyd/" />
        </label>
        <div class="inline-actions">
          <button class="primary-btn" type="submit">Load playlist</button>
          <button id="local-bundle-btn" class="secondary-btn" type="button">Load local .vzglyd</button>
          <input type="file" id="file-input" accept=".vzglyd" hidden />
        </div>
      </form>

      <p id="repo-summary" class="support-copy"></p>
    </section>

    <section id="playlist-shell" class="panel" hidden>
      <div class="panel-head">
        <div>
          <h2>Playlist</h2>
          <p id="playlist-meta" class="hint"></p>
        </div>
      </div>
      <div id="playlist-empty" class="empty-state" hidden>
        <strong>No slides</strong>
        <p>This playlist has no entries yet. Add them from the repo editor.</p>
      </div>
      <div id="playlist-list" class="playlist-list"></div>
    </section>

    <section id="canvas-shell" class="panel" hidden>
      <div class="panel-head">
        <div>
          <p class="eyebrow">Runtime</p>
          <h2 id="slide-name">No slide loaded</h2>
          <p id="slide-source" class="hint"></p>
        </div>
        <div id="slide-fps" class="fps-readout"></div>
      </div>

      <canvas id="render-canvas" width="640" height="480"></canvas>

      <div class="inline-actions">
        <button id="back-btn" class="secondary-btn" type="button">Unload current slide</button>
        <a id="active-slide-link" class="ghost-link" href="#" hidden>Open bundle URL</a>
      </div>
    </section>

    <div id="status-bar" hidden>
      <div id="status-spinner" class="spinner" hidden></div>
      <span id="status-text"></span>
    </div>

    <div id="error-box" hidden>
      <strong>Error</strong>
      <pre id="error-text"></pre>
      <button id="error-dismiss" class="secondary-btn" type="button">Dismiss</button>
    </div>

    <div id="no-webgpu" hidden>
      <strong>WebGPU not available</strong>
      <p id="no-webgpu-detail">
        This preview requires WebGPU. Try Chrome 113+, Edge 113+, or Safari 18+.
      </p>
      <p>
        On <strong>Linux</strong> (Chrome / Edge) enable the flag and relaunch:<br />
        <code>edge://flags/#enable-unsafe-webgpu</code> → <strong>Enabled</strong>
      </p>
      <p>
        On <strong>Windows / macOS</strong> make sure hardware acceleration is on:<br />
        <code>edge://settings/system</code> → <em>Use hardware acceleration when available</em>
      </p>
    </div>

    <div id="file-origin-warning" hidden>
      <strong>Serving over HTTP required</strong>
      <p>
        Edge and Chrome block WebGPU on <code>file://</code> pages. Serve this folder over a local
        HTTP server instead, then open <code>http://localhost:8080/web-preview/</code>.
      </p>
      <div class="cmd-list">
        <div class="cmd-row">
          <code id="cmd-python">python3 -m http.server 8080</code>
          <button class="copy-btn" data-target="cmd-python">Copy</button>
        </div>
        <div class="cmd-row">
          <code id="cmd-npx">npx serve . -l 8080</code>
          <button class="copy-btn" data-target="cmd-npx">Copy</button>
        </div>
        <div class="cmd-row">
          <code id="cmd-cargo">cargo install basic-http-server &amp;&amp; basic-http-server . -a 127.0.0.1:8080</code>
          <button class="copy-btn" data-target="cmd-cargo">Copy</button>
        </div>
      </div>
      <p class="hint">
        Serve the slide repo separately as well, then paste that repo base URL into the form above.
      </p>
    </div>

    <footer id="help-footer">
      Shared repo contract: <a href="../docs/shared-slide-repo.md">docs/shared-slide-repo.md</a>
    </footer>
  </div>
`;function d(){return(0,l.jsx)(`div`,{dangerouslySetInnerHTML:{__html:u}})}function f(){let e=`vzglyd.shared_repo_url`,i=document.getElementById(`repo-form`),a=document.getElementById(`repo-url`),s=document.getElementById(`repo-summary`),c=document.getElementById(`playlist-shell`),l=document.getElementById(`playlist-meta`),u=document.getElementById(`playlist-list`),d=document.getElementById(`playlist-empty`),f=document.getElementById(`local-bundle-btn`),p=document.getElementById(`file-input`),m=document.getElementById(`canvas-shell`),h=document.getElementById(`render-canvas`),g=document.getElementById(`slide-name`),_=document.getElementById(`slide-fps`),v=document.getElementById(`slide-source`),y=document.getElementById(`back-btn`),b=document.getElementById(`active-slide-link`),x=document.getElementById(`status-bar`),S=document.getElementById(`status-spinner`),C=document.getElementById(`status-text`),w=document.getElementById(`error-box`),T=document.getElementById(`error-text`),E=document.getElementById(`error-dismiss`),D=document.getElementById(`no-webgpu`),O=document.getElementById(`file-origin-warning`),k=document.getElementById(`open-editor-link`),A=document.getElementById(`open-player-link`),j=null,M=null,N=0,P={repo:null,currentSlideIndex:null,currentBundleUrl:null};function F(e,t=!1){x.hidden=!1,C.textContent=e,S.hidden=!t}function I(){x.hidden=!0,C.textContent=``,S.hidden=!0}function L(e){w.hidden=!1,T.textContent=e,console.error(`[vzglyd]`,e)}function R(){w.hidden=!0,T.textContent=``}function z(){m.hidden=!0,g.textContent=`No slide loaded`,v.textContent=``,_.textContent=``,b.hidden=!0,b.removeAttribute(`href`)}function B(){let e=new URL(`./editor.html`,window.location.href),t=new URL(`./view.html`,window.location.href);P.repo?.repoBaseUrl&&(e.searchParams.set(`repo`,P.repo.repoBaseUrl),t.searchParams.set(`repo`,P.repo.repoBaseUrl)),k.href=e.toString(),A.href=t.toString()}function V(){let e=new URL(window.location.href);P.repo?.repoBaseUrl?e.searchParams.set(`repo`,P.repo.repoBaseUrl):e.searchParams.delete(`repo`),P.repo?.repoBaseUrl&&Number.isInteger(P.currentSlideIndex)?e.searchParams.set(`slide`,String(P.currentSlideIndex)):e.searchParams.delete(`slide`),window.history.replaceState({},``,e),B()}function ee(e){return e.filter(e=>e.enabled!==!1).length}function H(e){let t=n(e,P.repo?.playlist.defaults??{}),r=[];return t.enabled||r.push(`disabled`),t.durationSeconds!=null&&r.push(`${t.durationSeconds}s`),t.transitionIn&&r.push(`in:${t.transitionIn}`),t.transitionOut&&r.push(`out:${t.transitionOut}`),t.hasParams&&r.push(`params`),r}function U(){if(u.replaceChildren(),!P.repo){c.hidden=!0;return}let{playlist:e,playlistUrl:t}=P.repo;c.hidden=!1,l.textContent=`${e.slides.length} entr${e.slides.length===1?`y`:`ies`} • ${ee(e.slides)} enabled • ${t}`,d.hidden=e.slides.length>0;for(let[t,n]of e.slides.entries()){let e=document.createElement(`button`);e.type=`button`,e.className=`playlist-item`,t===P.currentSlideIndex&&e.classList.add(`is-active`),n.enabled===!1&&e.classList.add(`is-disabled`);let r=document.createElement(`span`);r.className=`playlist-item-title`,r.textContent=n.path;let i=document.createElement(`span`);i.className=`playlist-item-badges`;for(let e of H(n)){let t=document.createElement(`span`);t.className=`badge-pill`,t.textContent=e,i.append(t)}let a=document.createElement(`span`);a.className=`playlist-item-detail`,n.params===void 0?a.textContent=t===P.currentSlideIndex?`Loaded into preview`:`Click to fetch and open this bundle`:a.textContent=`params ${JSON.stringify(n.params)}`,e.append(r,i,a),e.addEventListener(`click`,()=>{q(t)}),u.append(e)}}async function W(){return navigator.gpu?window.location.protocol===`file:`?(O.hidden=!1,!1):await navigator.gpu.requestAdapter({powerPreference:`high-performance`})??await navigator.gpu.requestAdapter()??await navigator.gpu.requestAdapter({forceFallbackAdapter:!0})?!0:(D.hidden=!1,!1):(D.hidden=!1,!1)}async function G(){if(!await W())return!1;F(`Loading engine...`,!0);try{let{default:e,WebHost:t}=await o(async()=>{let{default:e,WebHost:t}=await import(new URL(`./pkg/vzglyd_web.js`,window.location.href).toString());return{default:e,WebHost:t}},[]);return await e(),j=new t(h,{networkPolicy:`any_https`}),I(),!0}catch(e){return L(`Failed to initialize runtime: ${e.message}`),!1}}async function K(e,t,n=null,r=null){if(!j){L(`Host is not initialized`);return}try{R(),F(`Loading ${t}...`,!0),await j.loadBundle(e,{logLoadSummary:!0,params:r,slidePath:t});let i=j.stats()||{};g.textContent=i.slideName||i.manifestName||t,v.textContent=n??t,_.textContent=``,m.hidden=!1,n?(b.href=n,b.hidden=!1):b.hidden=!0,I(),Y()}catch(e){throw L(`Failed to load bundle: ${e.message}`),I(),z(),e}}async function q(e){if(!P.repo){L(`Load a slides repo first`);return}let n=P.repo.playlist.slides[e];if(!n){L(`Playlist entry ${e} does not exist`);return}try{R(),F(`Fetching ${n.path}...`,!0);let{bundleUrl:r,bytes:i}=await t(P.repo.repoBaseUrl,n.path);await K(i,n.path,r,n.params??null),P.currentSlideIndex=e,P.currentBundleUrl=r,V(),U()}catch(e){w.hidden&&L(e.message),I()}}async function J(e){if(!e.name.endsWith(`.vzglyd`)){L(`Please choose a .vzglyd file`);return}let t=new Uint8Array(await e.arrayBuffer());P.currentSlideIndex=null,P.currentBundleUrl=null;try{V(),await K(t,e.name),U()}catch(e){w.hidden&&L(e.message),I()}}function Y(){X();function e(t){if(j){N===0&&(N=t);try{j.frame(t);let e=j.stats()||{};typeof e.fps==`number`&&(_.textContent=`${Math.round(e.fps)} FPS`)}catch(e){console.error(`[vzglyd] frame error`,e),L(`Frame error: ${e.message}`),X();return}N=t,M=requestAnimationFrame(e)}}M=requestAnimationFrame(e)}function X(){M!=null&&(cancelAnimationFrame(M),M=null),N=0}function Z(e=!1){if(X(),j)try{j.teardown()}catch(e){console.warn(`[vzglyd] teardown failed`,e)}e&&(P.currentSlideIndex=null,P.currentBundleUrl=null,V(),U()),z()}function Q(){if(!P.repo){s.textContent=`Connect a static slide root to browse bundles from playlist.json.`;return}s.textContent=`Loaded ${P.repo.playlistUrl}`}async function $(t=null){try{R(),F(`Fetching playlist.json...`,!0);let n=await r(a.value);if(Z(),P.currentSlideIndex=null,P.currentBundleUrl=null,P.repo=n,a.value=n.repoBaseUrl,window.localStorage.setItem(e,n.repoBaseUrl),Q(),U(),V(),I(),Number.isInteger(t)&&n.playlist.slides[t]){await q(t);return}F(`Playlist ready. Select a bundle from ${n.playlist.slides.length} entr${n.playlist.slides.length===1?`y`:`ies`}.`,!1)}catch(e){L(e.message),I()}}function te(){document.querySelectorAll(`.copy-btn`).forEach(e=>{e.addEventListener(`click`,async()=>{let t=e.dataset.target,n=document.getElementById(t)?.textContent??``;try{await navigator.clipboard.writeText(n),e.textContent=`Copied`,e.classList.add(`copied`),window.setTimeout(()=>{e.textContent=`Copy`,e.classList.remove(`copied`)},1600)}catch{L(`Clipboard copy failed`)}})})}function ne(){i.addEventListener(`submit`,e=>{e.preventDefault(),$()}),f.addEventListener(`click`,()=>{p.click()}),p.addEventListener(`change`,e=>{let t=e.target.files?.[0];t&&(J(t),e.target.value=``)}),y.addEventListener(`click`,()=>{Z(!0)}),E.addEventListener(`click`,R)}async function re(){if(Q(),z(),B(),te(),ne(),!await G())return;let t=new URL(window.location.href),n=t.searchParams.get(`repo`)??window.localStorage.getItem(e),r=Number.parseInt(t.searchParams.get(`slide`)??``,10);n?(a.value=n,await $(Number.isInteger(r)?r:null)):F(`Ready. Connect a static slide root or load a local .vzglyd bundle.`,!1)}re()}function p(){return(0,s.useEffect)(()=>{f()},[]),(0,l.jsx)(d,{})}var m=document.getElementById(`react-root`);if(!m)throw Error(`Missing #react-root`);(0,c.createRoot)(m).render((0,l.jsx)(p,{}));