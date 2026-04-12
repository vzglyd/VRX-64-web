import{_ as e,a as t,c as n,d as r,f as i,g as a,h as o,l as s,m as c,o as l,p as u,r as d,s as f,t as p,u as m,v as h,y as g}from"./chunks/playlist_repo-sMAodyh6.js";var _=g(),v=h(),y=e(),b=String.raw`
<div id="app">
    <header class="hero">
      <div>
        <p class="eyebrow">Playlist editor</p>
        <h1>vzglyd repo editor</h1>
        <p class="subtitle">
          Load any static slide root, inspect bundle metadata, edit <code>playlist.json</code>,
          then export the updated file for commit. This tool edits playlist metadata only; it does
          not mutate bundle contents.
        </p>
      </div>
      <div class="hero-actions">
        <a id="open-preview-link" class="ghost-link" href="index.html">Open preview</a>
        <a id="open-player-link" class="ghost-link" href="view.html">Open player</a>
        <a class="ghost-link" href="../docs/shared-slide-repo.md">Repo contract</a>
      </div>
    </header>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Load repo</h2>
          <p class="hint">Point this tool at a static URL root that serves <code>playlist.json</code> and repo-relative <code>.vzglyd</code> bundles.</p>
        </div>
      </div>

      <form id="repo-form" class="repo-form">
        <label class="field grow">
          <span>Repo base URL</span>
          <input id="repo-url" type="url" placeholder="https://rodgerbenham.github.io/vzglyd/" />
        </label>
        <div class="inline-actions">
          <button class="primary-btn" type="submit">Load playlist</button>
          <button id="add-entry-btn" class="secondary-btn" type="button" disabled>Add entry</button>
          <button id="copy-json-btn" class="secondary-btn" type="button" disabled>Copy JSON</button>
          <button id="download-json-btn" class="secondary-btn" type="button" disabled>Download playlist.json</button>
        </div>
      </form>

      <p id="repo-summary" class="support-copy"></p>
    </section>

    <section class="panel editor-layout" id="editor-shell" hidden>
      <div class="panel-head">
        <div>
          <h2>Defaults</h2>
          <p class="hint">These values apply when an entry does not provide its own override.</p>
        </div>
      </div>

      <div class="form-grid">
        <label class="field">
          <span>Default duration</span>
          <input id="default-duration" type="number" min="1" max="300" placeholder="7" />
        </label>
        <label class="field">
          <span>Transition in</span>
          <select id="default-transition-in"></select>
        </label>
        <label class="field">
          <span>Transition out</span>
          <select id="default-transition-out"></select>
        </label>
      </div>

      <div class="panel-head">
        <div>
          <h2>Slides</h2>
          <p class="hint">Each entry path must be repo-root-relative. When bundles advertise param schemas, this editor renders guided controls instead of raw JSON.</p>
        </div>
      </div>

      <div id="entry-list" class="editor-entry-list"></div>

      <div class="output-shell">
        <div class="panel-head">
          <div>
            <h2>Generated playlist.json</h2>
            <p id="json-status" class="hint">Load a repo to begin editing.</p>
          </div>
        </div>
        <textarea id="json-output" readonly spellcheck="false"></textarea>
      </div>
    </section>

    <section class="panel" id="secrets-shell" hidden>
      <div class="panel-head">
        <div>
          <h2>Secrets</h2>
          <p class="hint">Environment variables injected into slides at runtime (e.g. API keys). Manage these locally — they are never sent to the repo.</p>
        </div>
      </div>

      <div class="secrets-warning" id="secrets-warning">
        &#9888; Do not commit <code>secrets.json</code> to a public repository &mdash; it contains plaintext API keys and credentials.
      </div>

      <div id="secrets-list" class="secrets-list"></div>

      <div class="secrets-add-form">
        <label class="field grow">
          <span>Key</span>
          <input id="secrets-new-key" type="text" placeholder="LASTFM_API_KEY" autocomplete="off" spellcheck="false" />
        </label>
        <label class="field grow">
          <span>Value</span>
          <input id="secrets-new-value" type="password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" autocomplete="new-password" />
        </label>
        <button id="secrets-add-btn" class="secondary-btn" type="button">Add</button>
      </div>

      <div class="inline-actions" style="margin-top:0.75rem">
        <button id="secrets-download-btn" class="secondary-btn" type="button">Download secrets.json</button>
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

    <footer id="help-footer">
      Exported changes still need to be written back to the source repo and committed separately.
    </footer>
  </div>
`;function x(){return(0,y.jsx)(`div`,{dangerouslySetInnerHTML:{__html:b}})}function S(){let e=`vzglyd.shared_repo_url`,h=document.getElementById(`repo-form`),g=document.getElementById(`repo-url`),_=document.getElementById(`repo-summary`),v=document.getElementById(`add-entry-btn`),y=document.getElementById(`copy-json-btn`),b=document.getElementById(`download-json-btn`),x=document.getElementById(`default-duration`),S=document.getElementById(`default-transition-in`),C=document.getElementById(`default-transition-out`),w=document.getElementById(`entry-list`),ee=document.getElementById(`editor-shell`),T=document.getElementById(`json-status`),E=document.getElementById(`json-output`),te=document.getElementById(`open-preview-link`),ne=document.getElementById(`open-player-link`),D=document.getElementById(`status-bar`),O=document.getElementById(`status-spinner`),k=document.getElementById(`status-text`),A=document.getElementById(`error-box`),j=document.getElementById(`error-text`),re=document.getElementById(`error-dismiss`),M=document.getElementById(`secrets-shell`),N=document.getElementById(`secrets-list`),ie=document.getElementById(`secrets-new-key`),ae=document.getElementById(`secrets-new-value`),oe=document.getElementById(`secrets-add-btn`),se=document.getElementById(`secrets-download-btn`),P={repoBaseUrl:null,playlistUrl:``,editablePlaylist:null,renderedJson:``,loadedJson:``,metadataRequestId:0,secrets:null};function F(e,t=!1){D.hidden=!1,k.textContent=e,O.hidden=!t}function ce(){D.hidden=!0,k.textContent=``,O.hidden=!0}function I(e){A.hidden=!1,j.textContent=e}function L(){A.hidden=!0,j.textContent=``}function R(){if(P.secrets===null){M.hidden=!0;return}M.hidden=!1,N.replaceChildren();let e=Object.entries(P.secrets);if(e.length===0){let e=document.createElement(`p`);e.className=`hint`,e.textContent=`No secrets stored. Add a key/value pair below.`,N.appendChild(e)}else for(let[t]of e){let e=document.createElement(`div`);e.className=`secrets-row`,e.innerHTML=`
        <code class="secrets-key">${z(t)}</code>
        <span class="secrets-value">••••••••</span>
        <button class="secondary-btn secrets-remove-btn" data-key="${z(t)}" type="button">Remove</button>
      `,N.appendChild(e)}}function z(e){return String(e).replace(/&/g,`&amp;`).replace(/</g,`&lt;`).replace(/>/g,`&gt;`).replace(/"/g,`&quot;`)}function le(){let e=[``];return e.push(...p),e}function B(e,t=``){e.replaceChildren();for(let n of le()){let r=document.createElement(`option`);r.value=n,r.textContent=n||`Inherit / none`,n===t&&(r.selected=!0),e.append(r)}}function V(){return!!(P.loadedJson&&P.renderedJson&&P.renderedJson!==P.loadedJson)}function H(){let e=new URL(`./index.html`,window.location.href),t=new URL(`./view.html`,window.location.href);P.repoBaseUrl&&(e.searchParams.set(`repo`,P.repoBaseUrl),t.searchParams.set(`repo`,P.repoBaseUrl)),te.href=e.toString(),ne.href=t.toString()}function U(){if(!P.editablePlaylist){_.textContent=`Load a static slide root URL to edit playlist.json.`;return}let e=P.editablePlaylist.slides.length,t=P.renderedJson?V()?`local changes pending export`:`matches loaded playlist`:`fix validation errors to export`;_.textContent=`Loaded ${P.playlistUrl} • ${e} entr${e===1?`y`:`ies`} • ${t}`}function W(){let e=!!P.editablePlaylist;ee.hidden=!e,v.disabled=!e,y.disabled=!e||!P.renderedJson,b.disabled=!e||!P.renderedJson,U(),H()}function ue(e){let t=new URL(`./index.html`,window.location.href);return P.repoBaseUrl&&(t.searchParams.set(`repo`,P.repoBaseUrl),t.searchParams.set(`slide`,String(e))),t.toString()}function G(e){`params_editor_mode`in e||(e.params_editor_mode=`raw`),(!(`params_form_values`in e)||typeof e.params_form_values!=`object`)&&(e.params_form_values={}),`params_schema`in e||(e.params_schema=null),`params_editor_message`in e||(e.params_editor_message=``),`bundle_manifest`in e||(e.bundle_manifest=null),`bundle_manifest_status`in e||(e.bundle_manifest_status=`idle`),`bundle_error`in e||(e.bundle_error=``),`bundle_url`in e||(e.bundle_url=``)}function K(e,t=`idle`){G(e),e.bundle_manifest=null,e.bundle_manifest_status=t,e.bundle_error=``,e.bundle_url=``,e.params_schema=null,e.params_form_values={},e.params_editor_mode!==`raw`&&(e.params_editor_mode=`raw`),e.params_text||(e.params_editor_message=``)}function de(e,t,n){if(G(e),e.bundle_manifest=t,e.bundle_manifest_status=`ready`,e.bundle_error=``,e.bundle_url=n,e.params_schema=t.params??null,!t.params){e.params_editor_mode=`raw`,e.params_form_values={},e.params_editor_message=``;return}try{let n=s(e.params_text,`params`);e.params_form_values=o(t.params,n,`params`),e.params_editor_mode=`schema`,e.params_editor_message=``}catch(t){e.params_editor_mode=`raw`,e.params_form_values={},e.params_editor_message=`Bundle schema found, but current params stay in raw JSON: ${t.message}`}}async function q(e,{render:n=!0}={}){G(e);let r=String(e.path??``).trim(),i=P.repoBaseUrl;if(!r||!i){K(e,`idle`),n&&Q();return}K(e,`loading`),n&&Q();try{let{bundleUrl:n,manifest:a}=await t(i,r);if(P.repoBaseUrl!==i||String(e.path??``).trim()!==r)return;de(e,a,n)}catch(t){if(P.repoBaseUrl!==i||String(e.path??``).trim()!==r)return;K(e,`error`),e.bundle_error=t.message,e.params_editor_message=``}n&&Q()}async function fe(){if(!P.editablePlaylist||!P.repoBaseUrl)return;let e=++P.metadataRequestId,t=P.editablePlaylist.slides.filter(e=>String(e.path??``).trim()!==``);if(t.length===0){F(`Playlist ready. Add a slide entry to begin editing.`,!1),Q();return}for(let e of t)K(e,`loading`);if(Q(),F(`Reading bundle metadata for ${t.length} slide${t.length===1?``:`s`}...`,!0),await Promise.all(t.map(e=>q(e,{render:!1}))),e!==P.metadataRequestId)return;Q();let n=t.filter(e=>e.bundle_manifest_status===`ready`).length,r=t.filter(e=>e.bundle_manifest_status===`error`).length;F(r===0?`Loaded bundle metadata for ${n} slide${n===1?``:`s`}.`:`Loaded bundle metadata for ${n} slide${n===1?``:`s`}; ${r} entr${r===1?`y`:`ies`} could not be inspected.`,!1)}function J(e,t=``){let n=document.createElement(`p`);return n.className=`field-note${t?` is-${t}`:``}`,n.textContent=e,n}function Y(e,t){let n=e[t],r=P.editablePlaylist?.defaults?.[t]??``,i=e.bundle_manifest?.display?.[t]??null;return n===``?r===``?i!=null&&i!==``?`Bundle default: ${i}.`:`No default value.`:`Inherited from playlist defaults: ${r}.`:r===``?i!=null&&i!==``?`Explicit override. Bundle default is ${i}.`:`Explicit override.`:`Explicit override. Playlist default is ${r}.`}function pe(e){let t=e.bundle_manifest,n=[];return e.bundle_manifest_status===`loading`&&n.push(`reading metadata`),e.bundle_manifest_status===`error`&&n.push(`metadata unavailable`),t?(t.author&&n.push(`by ${t.author}`),t.scene_space&&n.push(t.scene_space),t.display?.duration_seconds!=null&&n.push(`bundle ${t.display.duration_seconds}s`),t.display?.transition_in&&n.push(`in:${t.display.transition_in}`),t.display?.transition_out&&n.push(`out:${t.display.transition_out}`),t.assets?.art&&n.push(`cassette art`),t.params?.fields?.length&&n.push(`${t.params.fields.length} param field${t.params.fields.length===1?``:`s`}`),n):n}function me(e){let t=e?.assets?.art;if(!t)return null;let n=document.createElement(`div`);n.className=`cassette-art-summary`;let r=[[`J-card`,t.j_card],[`Side A`,t.side_a_label],[`Side B`,t.side_b_label]];for(let[e,t]of r){let r=document.createElement(`div`);r.className=`cassette-art-chip`;let i=document.createElement(`span`);i.textContent=e;let a=document.createElement(`code`);a.textContent=t.path,r.append(i,a),n.append(r)}return n}function he(e){let t=document.createElement(`div`);t.className=`entry-summary`;let n=document.createElement(`div`);n.className=`entry-summary-title`,n.textContent=(e.bundle_manifest?.name??e.path)||`New slide`,t.append(n);let r=pe(e);if(r.length>0){let e=document.createElement(`div`);e.className=`badge-row`;for(let t of r){let n=document.createElement(`span`);n.className=`badge-pill`,n.textContent=t,e.append(n)}t.append(e)}if(e.bundle_manifest_status===`loading`)return t.append(J(`Loading bundle manifest and advertised params...`)),t;if(e.bundle_manifest_status===`error`)return t.append(J(`Bundle metadata unavailable: ${e.bundle_error}`,`error`)),t;if(!e.bundle_manifest)return t.append(J(`Save the bundle path, then the editor will inspect that bundle for metadata and params.`)),t;let i=e.bundle_manifest.description||e.bundle_url;i&&t.append(J(i));let a=me(e.bundle_manifest);return a&&t.append(a),t}function ge(e,t){let n=c(e),r=document.createElement(`label`);r.className=`field${e.type===`json`?` is-wide`:``}`;let i=document.createElement(`span`);i.textContent=e.required?`${n.label} *`:n.label,r.append(i);let a;if(e.options.length>0||e.type===`boolean`){a=document.createElement(`select`);let r=document.createElement(`option`);r.value=``,e.default===void 0?e.required?r.textContent=`Choose a value`:r.textContent=`Unset / omit`:r.textContent=`Use bundle default (${n.defaultText})`,a.append(r);let i=e.options.length>0?e.options.map(t=>({value:e.type===`string`?t.value:JSON.stringify(t.value),label:t.label??String(t.value)})):[{value:`true`,label:`true`},{value:`false`,label:`false`}];for(let e of i){let t=document.createElement(`option`);t.value=e.value,t.textContent=e.label,a.append(t)}a.value=t??``}else e.type===`json`?(a=document.createElement(`textarea`),a.placeholder=n.defaultText||`{
  "key": "value"
}`,a.value=t??``):(a=document.createElement(`input`),a.type=e.type===`integer`||e.type===`number`?`number`:`text`,e.type===`integer`&&(a.step=`1`),e.type===`number`&&(a.step=`any`),a.placeholder=e.default===void 0?``:String(e.default),a.value=t??``);a.dataset.paramKey=e.key,r.append(a);let o=[];return n.help&&o.push(n.help),e.default!==void 0&&o.push(`Bundle default: ${n.defaultText}`),e.required||o.push(`Blank values stay out of playlist.json`),r.append(J(o.join(` • `))),r}function _e(e){let t=document.createElement(`div`);t.className=`entry-params-shell`;let n=document.createElement(`div`);n.className=`entry-params-head`;let r=document.createElement(`div`),i=document.createElement(`h3`);i.textContent=`Guided params`;let a=document.createElement(`p`);a.className=`hint`,a.textContent=`Blank fields keep bundle defaults and are omitted from playlist.json.`,r.append(i,a);let o=document.createElement(`button`);o.type=`button`,o.className=`secondary-btn`,o.dataset.action=`use-raw`,o.textContent=`Edit raw JSON`,n.append(r,o),t.append(n),e.params_editor_message&&t.append(J(e.params_editor_message));let s=document.createElement(`div`);s.className=`form-grid`;for(let t of e.params_schema.fields)s.append(ge(t,e.params_form_values[t.key]??``));return t.append(s),t}function ve(e){let t=document.createElement(`div`);t.className=`entry-params-shell`;let n=document.createElement(`div`);n.className=`entry-params-head`;let r=document.createElement(`div`),i=document.createElement(`h3`);i.textContent=e.params_schema?`Raw params JSON`:`Params JSON`;let a=document.createElement(`p`);if(a.className=`hint`,e.params_schema?a.textContent=`Bundle guidance is available, but this slide is currently using raw JSON editing.`:e.bundle_manifest_status===`ready`?a.textContent=`This bundle does not advertise editable params, so raw JSON is the only option.`:a.textContent=`Edit params as raw JSON. Guided controls appear automatically when the bundle advertises them.`,r.append(i,a),n.append(r),e.params_schema){let e=document.createElement(`button`);e.type=`button`,e.className=`secondary-btn`,e.dataset.action=`use-schema`,e.textContent=`Use guided fields`,n.append(e)}t.append(n),e.params_editor_message&&t.append(J(e.params_editor_message,e.params_schema?`warning`:``));let o=document.createElement(`label`);o.className=`field is-wide`,o.innerHTML=`<span>Params JSON</span>`;let s=document.createElement(`textarea`);return s.dataset.field=`params_text`,s.placeholder=`{
  "mode": "demo"
}`,s.value=e.params_text,o.append(s),t.append(o),t}function X(){w.replaceChildren();for(let[e,t]of P.editablePlaylist.slides.entries()){G(t);let n=document.createElement(`section`);n.className=`editor-entry`,n.dataset.index=String(e);let r=document.createElement(`div`);r.className=`entry-topline`;let i=document.createElement(`span`);i.className=`entry-index`,i.textContent=`Slide ${e+1}`;let a=document.createElement(`div`);a.className=`entry-actions`;let o=document.createElement(`a`);o.className=`ghost-link`,o.href=ue(e),o.textContent=`Preview`;let s=document.createElement(`button`);s.type=`button`,s.className=`secondary-btn`,s.dataset.action=`reload-manifest`,s.textContent=`Reload metadata`,s.disabled=!String(t.path??``).trim();let c=document.createElement(`button`);c.type=`button`,c.className=`icon-btn`,c.dataset.action=`move-up`,c.textContent=`↑`,c.disabled=e===0;let l=document.createElement(`button`);l.type=`button`,l.className=`icon-btn`,l.dataset.action=`move-down`,l.textContent=`↓`,l.disabled=e===P.editablePlaylist.slides.length-1;let u=document.createElement(`button`);u.type=`button`,u.className=`icon-btn`,u.dataset.action=`remove`,u.textContent=`Remove`,a.append(o,s,c,l,u),r.append(i,a),n.append(r,he(t));let d=document.createElement(`div`);d.className=`form-grid`;let f=document.createElement(`label`);f.className=`field`,f.innerHTML=`
      <span>Bundle path</span>
      <input data-field="path" value="${z(t.path)}" placeholder="clock.vzglyd" />
    `,f.append(J(`Repo-root-relative path inside the static slide root.`));let p=document.createElement(`label`);p.className=`field`,p.innerHTML=`
      <span>Enabled</span>
      <select data-field="enabled">
        <option value="true"${t.enabled?` selected`:``}>true</option>
        <option value="false"${t.enabled?``:` selected`}>false</option>
      </select>
    `;let m=document.createElement(`label`);m.className=`field`,m.innerHTML=`
      <span>Duration seconds</span>
      <input data-field="duration_seconds" type="number" min="1" max="300" value="${z(t.duration_seconds)}" placeholder="inherit" />
    `,m.append(J(Y(t,`duration_seconds`)));let h=document.createElement(`label`);h.className=`field`,h.innerHTML=`<span>Transition in</span>`;let g=document.createElement(`select`);g.dataset.field=`transition_in`,B(g,t.transition_in),h.append(g,J(Y(t,`transition_in`)));let _=document.createElement(`label`);_.className=`field`,_.innerHTML=`<span>Transition out</span>`;let v=document.createElement(`select`);v.dataset.field=`transition_out`,B(v,t.transition_out),_.append(v,J(Y(t,`transition_out`))),d.append(f,p,m,h,_),n.append(d),t.params_schema&&t.params_editor_mode===`schema`?n.append(_e(t)):n.append(ve(t)),w.append(n)}}function Z(){if(!P.editablePlaylist){P.renderedJson=``,E.value=``,T.textContent=`Load a repo to begin editing.`,W();return}try{P.renderedJson=r(m(P.editablePlaylist)),E.value=P.renderedJson,T.textContent=V()?`playlist.json is valid. Export the updated file to commit these changes.`:`playlist.json is valid and still matches the loaded source.`}catch(e){P.renderedJson=``,E.value=``,T.textContent=e.message}W()}function Q(){if(!P.editablePlaylist){W();return}x.value=P.editablePlaylist.defaults.duration_seconds,B(S,P.editablePlaylist.defaults.transition_in),B(C,P.editablePlaylist.defaults.transition_out),X(),Z()}function ye(e){if(!(!e.params_schema||e.params_editor_mode!==`schema`))try{let t=a(e.params_schema,e.params_form_values,`params`);e.params_text=t===void 0?``:JSON.stringify(t,null,2)}catch{}}function be(e){if(!e.params_schema)return;let t=s(e.params_text,`params`);e.params_form_values=o(e.params_schema,t,`params`),e.params_editor_mode=`schema`,e.params_editor_message=``}function xe(e){ye(e),e.params_editor_mode=`raw`,e.params_editor_message=`Editing raw JSON. Switch back to guided fields when the JSON matches the bundle schema.`}async function Se(){try{L(),F(`Fetching playlist.json...`,!0);let t=await l(g.value);P.repoBaseUrl=t.repoBaseUrl,P.playlistUrl=t.playlistUrl,P.loadedJson=r(t.playlist),P.editablePlaylist=u(t.playlist),P.renderedJson=P.loadedJson;for(let e of P.editablePlaylist.slides)G(e);g.value=t.repoBaseUrl,window.localStorage.setItem(e,t.repoBaseUrl);try{F(`Fetching secrets.json...`,!0);let e=await f(t.repoBaseUrl);P.secrets=e?e.secrets:{}}catch{P.secrets={}}Q(),R(),await fe()}catch(e){I(e.message),ce()}}function Ce(e,t){let n=e+t;if(n<0||n>=P.editablePlaylist.slides.length)return;let[r]=P.editablePlaylist.slides.splice(e,1);P.editablePlaylist.slides.splice(n,0,r),Q()}function $(e,t){if(t.dataset.paramKey){e.params_form_values[t.dataset.paramKey]=t.value,ye(e),Z();return}let n=t.dataset.field;n&&(n===`enabled`?e.enabled=t.value!==`false`:e[n]=t.value,n===`path`&&K(e,(t.value.trim(),`idle`)),Z())}function we(){h.addEventListener(`submit`,e=>{e.preventDefault(),Se()}),v.addEventListener(`click`,()=>{let e=d();G(e),P.editablePlaylist.slides.push(e),Q()}),x.addEventListener(`input`,()=>{P.editablePlaylist.defaults.duration_seconds=x.value,Z()}),S.addEventListener(`change`,()=>{P.editablePlaylist.defaults.transition_in=S.value,Z(),X()}),C.addEventListener(`change`,()=>{P.editablePlaylist.defaults.transition_out=C.value,Z(),X()}),w.addEventListener(`input`,e=>{let t=e.target,n=t.closest(`.editor-entry`);if(!n)return;let r=Number.parseInt(n.dataset.index??``,10),i=P.editablePlaylist.slides[r];i&&$(i,t)}),w.addEventListener(`change`,e=>{let t=e.target,n=t.closest(`.editor-entry`);if(!n)return;let r=Number.parseInt(n.dataset.index??``,10),i=P.editablePlaylist.slides[r];i&&($(i,t),t.dataset.field===`path`&&q(i))}),w.addEventListener(`click`,e=>{let t=e.target.closest(`button[data-action]`);if(!t)return;let n=t.closest(`.editor-entry`);if(!n)return;let r=Number.parseInt(n.dataset.index??``,10),i=P.editablePlaylist.slides[r];if(i)switch(t.dataset.action){case`move-up`:Ce(r,-1);break;case`move-down`:Ce(r,1);break;case`remove`:P.editablePlaylist.slides.splice(r,1),Q();break;case`reload-manifest`:q(i);break;case`use-schema`:try{be(i),Q()}catch(e){I(e.message)}break;case`use-raw`:xe(i),Q();break;default:break}}),y.addEventListener(`click`,async()=>{if(P.renderedJson)try{await navigator.clipboard.writeText(P.renderedJson),F(`playlist.json copied to clipboard.`,!1)}catch{I(`Clipboard copy failed`)}}),b.addEventListener(`click`,()=>{if(!P.renderedJson)return;let e=new Blob([P.renderedJson],{type:`application/json`}),t=URL.createObjectURL(e),n=document.createElement(`a`);n.href=t,n.download=`playlist.json`,n.click(),URL.revokeObjectURL(t),F(`playlist.json downloaded.`,!1)}),re.addEventListener(`click`,L),oe.addEventListener(`click`,()=>{let e=ie.value.trim(),t=ae.value;if(!e){I(`Secret key must not be empty`);return}P.secrets===null&&(P.secrets={}),P.secrets[e]=t,ie.value=``,ae.value=``,R()}),N.addEventListener(`click`,e=>{let t=e.target.closest(`.secrets-remove-btn`);if(!t||P.secrets===null)return;let n=t.dataset.key;n!==void 0&&(delete P.secrets[n],R())}),se.addEventListener(`click`,()=>{if(P.secrets===null)return;let e=i(P.secrets),t=new Blob([e],{type:`application/json`}),n=URL.createObjectURL(t),r=document.createElement(`a`);r.href=n,r.download=`secrets.json`,r.click(),URL.revokeObjectURL(n),F(`secrets.json downloaded. Keep this file out of version control.`,!1)})}function Te(){U(),B(S),B(C),H(),we(),W();let t=new URL(window.location.href).searchParams.get(`repo`)??window.localStorage.getItem(e);if(t)try{g.value=n(t,window.location.href),Se()}catch{window.localStorage.removeItem(e)}}Te()}function C(){return(0,_.useEffect)(()=>{S()},[]),(0,y.jsx)(x,{})}var w=document.getElementById(`react-root`);if(!w)throw Error(`Missing #react-root`);(0,v.createRoot)(w).render((0,y.jsx)(C,{}));