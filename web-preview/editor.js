import {
  TRANSITION_OPTIONS,
  emptyEditableEntry,
  loadBundleManifestFromRepo,
  loadPlaylistFromRepo,
  normalizeRepoBaseUrl,
  parseParamsText,
  serializeEditablePlaylist,
  stringifyPlaylist,
  toEditablePlaylist,
} from './js/playlist_repo.js';
import {
  describeParamField,
  formValuesFromSchemaParams,
  serializeParamsFromFormValues,
} from './js/param_schema.js';

const REPO_STORAGE_KEY = 'vzglyd.shared_repo_url';

const repoForm = document.getElementById('repo-form');
const repoUrlInput = document.getElementById('repo-url');
const repoSummary = document.getElementById('repo-summary');
const addEntryBtn = document.getElementById('add-entry-btn');
const copyJsonBtn = document.getElementById('copy-json-btn');
const downloadJsonBtn = document.getElementById('download-json-btn');
const defaultDurationInput = document.getElementById('default-duration');
const defaultTransitionIn = document.getElementById('default-transition-in');
const defaultTransitionOut = document.getElementById('default-transition-out');
const entryList = document.getElementById('entry-list');
const editorShell = document.getElementById('editor-shell');
const jsonStatus = document.getElementById('json-status');
const jsonOutput = document.getElementById('json-output');
const openPreviewLink = document.getElementById('open-preview-link');
const openPlayerLink = document.getElementById('open-player-link');
const statusBar = document.getElementById('status-bar');
const statusSpinner = document.getElementById('status-spinner');
const statusText = document.getElementById('status-text');
const errorBox = document.getElementById('error-box');
const errorText = document.getElementById('error-text');
const errorDismiss = document.getElementById('error-dismiss');

const state = {
  repoBaseUrl: null,
  playlistUrl: '',
  editablePlaylist: null,
  renderedJson: '',
  loadedJson: '',
  metadataRequestId: 0,
};

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
}

function hideError() {
  errorBox.hidden = true;
  errorText.textContent = '';
}

function buildTransitionOptions() {
  const options = [''];
  options.push(...TRANSITION_OPTIONS);
  return options;
}

function fillTransitionSelect(select, selectedValue = '') {
  select.replaceChildren();
  for (const value of buildTransitionOptions()) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value || 'Inherit / none';
    if (value === selectedValue) {
      option.selected = true;
    }
    select.append(option);
  }
}

function hasUnsavedChanges() {
  return Boolean(state.loadedJson && state.renderedJson && state.renderedJson !== state.loadedJson);
}

function updateLinks() {
  const previewUrl = new URL('./index.html', window.location.href);
  const playerUrl = new URL('./view.html', window.location.href);
  if (state.repoBaseUrl) {
    previewUrl.searchParams.set('repo', state.repoBaseUrl);
    playerUrl.searchParams.set('repo', state.repoBaseUrl);
  }
  openPreviewLink.href = previewUrl.toString();
  openPlayerLink.href = playerUrl.toString();
}

function setRepoSummary() {
  if (!state.editablePlaylist) {
    repoSummary.textContent = 'Load a static slide root URL to edit playlist.json.';
    return;
  }

  const entryCount = state.editablePlaylist.slides.length;
  const dirtyState = !state.renderedJson
    ? 'fix validation errors to export'
    : (hasUnsavedChanges() ? 'local changes pending export' : 'matches loaded playlist');
  repoSummary.textContent =
    `Loaded ${state.playlistUrl} • ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'} • ${dirtyState}`;
}

function syncControls() {
  const ready = Boolean(state.editablePlaylist);
  editorShell.hidden = !ready;
  addEntryBtn.disabled = !ready;
  copyJsonBtn.disabled = !ready || !state.renderedJson;
  downloadJsonBtn.disabled = !ready || !state.renderedJson;
  setRepoSummary();
  updateLinks();
}

function entryPreviewHref(index) {
  const url = new URL('./index.html', window.location.href);
  if (state.repoBaseUrl) {
    url.searchParams.set('repo', state.repoBaseUrl);
    url.searchParams.set('slide', String(index));
  }
  return url.toString();
}

function ensureEntryEditorState(entry) {
  if (!('params_editor_mode' in entry)) {
    entry.params_editor_mode = 'raw';
  }
  if (!('params_form_values' in entry) || typeof entry.params_form_values !== 'object') {
    entry.params_form_values = {};
  }
  if (!('params_schema' in entry)) {
    entry.params_schema = null;
  }
  if (!('params_editor_message' in entry)) {
    entry.params_editor_message = '';
  }
  if (!('bundle_manifest' in entry)) {
    entry.bundle_manifest = null;
  }
  if (!('bundle_manifest_status' in entry)) {
    entry.bundle_manifest_status = 'idle';
  }
  if (!('bundle_error' in entry)) {
    entry.bundle_error = '';
  }
  if (!('bundle_url' in entry)) {
    entry.bundle_url = '';
  }
}

function resetEntryBundleState(entry, status = 'idle') {
  ensureEntryEditorState(entry);
  entry.bundle_manifest = null;
  entry.bundle_manifest_status = status;
  entry.bundle_error = '';
  entry.bundle_url = '';
  entry.params_schema = null;
  entry.params_form_values = {};
  if (entry.params_editor_mode !== 'raw') {
    entry.params_editor_mode = 'raw';
  }
  if (!entry.params_text) {
    entry.params_editor_message = '';
  }
}

function applyManifestToEntry(entry, manifest, bundleUrl) {
  ensureEntryEditorState(entry);
  entry.bundle_manifest = manifest;
  entry.bundle_manifest_status = 'ready';
  entry.bundle_error = '';
  entry.bundle_url = bundleUrl;
  entry.params_schema = manifest.params ?? null;

  if (!manifest.params) {
    entry.params_editor_mode = 'raw';
    entry.params_form_values = {};
    entry.params_editor_message = '';
    return;
  }

  try {
    const params = parseParamsText(entry.params_text, 'params');
    entry.params_form_values = formValuesFromSchemaParams(manifest.params, params, 'params');
    entry.params_editor_mode = 'schema';
    entry.params_editor_message = '';
  } catch (error) {
    entry.params_editor_mode = 'raw';
    entry.params_form_values = {};
    entry.params_editor_message =
      `Bundle schema found, but current params stay in raw JSON: ${error.message}`;
  }
}

async function refreshEntryManifest(entry, { render = true } = {}) {
  ensureEntryEditorState(entry);
  const requestedPath = String(entry.path ?? '').trim();
  const requestedRepoBaseUrl = state.repoBaseUrl;

  if (!requestedPath || !requestedRepoBaseUrl) {
    resetEntryBundleState(entry, requestedPath ? 'idle' : 'idle');
    if (render) {
      renderEditor();
    }
    return;
  }

  resetEntryBundleState(entry, 'loading');
  if (render) {
    renderEditor();
  }

  try {
    const { bundleUrl, manifest } = await loadBundleManifestFromRepo(requestedRepoBaseUrl, requestedPath);
    if (state.repoBaseUrl !== requestedRepoBaseUrl || String(entry.path ?? '').trim() !== requestedPath) {
      return;
    }
    applyManifestToEntry(entry, manifest, bundleUrl);
  } catch (error) {
    if (state.repoBaseUrl !== requestedRepoBaseUrl || String(entry.path ?? '').trim() !== requestedPath) {
      return;
    }
    resetEntryBundleState(entry, 'error');
    entry.bundle_error = error.message;
    entry.params_editor_message = '';
  }

  if (render) {
    renderEditor();
  }
}

async function hydrateBundleMetadata() {
  if (!state.editablePlaylist || !state.repoBaseUrl) {
    return;
  }

  const requestId = ++state.metadataRequestId;
  const entries = state.editablePlaylist.slides.filter((entry) => String(entry.path ?? '').trim() !== '');
  if (entries.length === 0) {
    setStatus('Playlist ready. Add a slide entry to begin editing.', false);
    renderEditor();
    return;
  }

  for (const entry of entries) {
    resetEntryBundleState(entry, 'loading');
  }
  renderEditor();
  setStatus(
    `Reading bundle metadata for ${entries.length} slide${entries.length === 1 ? '' : 's'}...`,
    true,
  );

  await Promise.all(entries.map((entry) => refreshEntryManifest(entry, { render: false })));
  if (requestId !== state.metadataRequestId) {
    return;
  }

  renderEditor();
  const readyCount = entries.filter((entry) => entry.bundle_manifest_status === 'ready').length;
  const failedCount = entries.filter((entry) => entry.bundle_manifest_status === 'error').length;

  if (failedCount === 0) {
    setStatus(
      `Loaded bundle metadata for ${readyCount} slide${readyCount === 1 ? '' : 's'}.`,
      false,
    );
  } else {
    setStatus(
      `Loaded bundle metadata for ${readyCount} slide${readyCount === 1 ? '' : 's'}; ${failedCount} entr${failedCount === 1 ? 'y' : 'ies'} could not be inspected.`,
      false,
    );
  }
}

function createFieldNote(text, tone = '') {
  const note = document.createElement('p');
  note.className = `field-note${tone ? ` is-${tone}` : ''}`;
  note.textContent = text;
  return note;
}

function describeInheritedDisplay(entry, key) {
  const ownValue = entry[key];
  const playlistValue = state.editablePlaylist?.defaults?.[key] ?? '';
  const bundleValue = entry.bundle_manifest?.display?.[key] ?? null;

  if (ownValue !== '') {
    if (playlistValue !== '') {
      return `Explicit override. Playlist default is ${playlistValue}.`;
    }
    if (bundleValue != null && bundleValue !== '') {
      return `Explicit override. Bundle default is ${bundleValue}.`;
    }
    return 'Explicit override.';
  }

  if (playlistValue !== '') {
    return `Inherited from playlist defaults: ${playlistValue}.`;
  }
  if (bundleValue != null && bundleValue !== '') {
    return `Bundle default: ${bundleValue}.`;
  }
  return 'No default value.';
}

function describeManifestBadges(entry) {
  const manifest = entry.bundle_manifest;
  const badges = [];

  if (entry.bundle_manifest_status === 'loading') {
    badges.push('reading metadata');
  }
  if (entry.bundle_manifest_status === 'error') {
    badges.push('metadata unavailable');
  }
  if (!manifest) {
    return badges;
  }

  if (manifest.author) badges.push(`by ${manifest.author}`);
  if (manifest.scene_space) badges.push(manifest.scene_space);
  if (manifest.display?.duration_seconds != null) badges.push(`bundle ${manifest.display.duration_seconds}s`);
  if (manifest.display?.transition_in) badges.push(`in:${manifest.display.transition_in}`);
  if (manifest.display?.transition_out) badges.push(`out:${manifest.display.transition_out}`);
  if (manifest.params?.fields?.length) {
    badges.push(`${manifest.params.fields.length} param field${manifest.params.fields.length === 1 ? '' : 's'}`);
  }

  return badges;
}

function buildManifestSummary(entry) {
  const shell = document.createElement('div');
  shell.className = 'entry-summary';

  const title = document.createElement('div');
  title.className = 'entry-summary-title';
  title.textContent = (entry.bundle_manifest?.name ?? entry.path) || 'New slide';
  shell.append(title);

  const badges = describeManifestBadges(entry);
  if (badges.length > 0) {
    const badgeRow = document.createElement('div');
    badgeRow.className = 'badge-row';
    for (const value of badges) {
      const badge = document.createElement('span');
      badge.className = 'badge-pill';
      badge.textContent = value;
      badgeRow.append(badge);
    }
    shell.append(badgeRow);
  }

  if (entry.bundle_manifest_status === 'loading') {
    shell.append(createFieldNote('Loading bundle manifest and advertised params...'));
    return shell;
  }

  if (entry.bundle_manifest_status === 'error') {
    shell.append(createFieldNote(`Bundle metadata unavailable: ${entry.bundle_error}`, 'error'));
    return shell;
  }

  if (!entry.bundle_manifest) {
    shell.append(createFieldNote('Save the bundle path, then the editor will inspect that bundle for metadata and params.'));
    return shell;
  }

  const description = entry.bundle_manifest.description || entry.bundle_url;
  if (description) {
    shell.append(createFieldNote(description));
  }

  return shell;
}

function buildSchemaControl(field, currentValue) {
  const descriptor = describeParamField(field);
  const wrapper = document.createElement('label');
  wrapper.className = `field${field.type === 'json' ? ' is-wide' : ''}`;

  const label = document.createElement('span');
  label.textContent = field.required ? `${descriptor.label} *` : descriptor.label;
  wrapper.append(label);

  let control;
  if (field.options.length > 0 || field.type === 'boolean') {
    control = document.createElement('select');
    const blankOption = document.createElement('option');
    blankOption.value = '';
    if (field.default !== undefined) {
      blankOption.textContent = `Use bundle default (${descriptor.defaultText})`;
    } else if (field.required) {
      blankOption.textContent = 'Choose a value';
    } else {
      blankOption.textContent = 'Unset / omit';
    }
    control.append(blankOption);

    const options = field.options.length > 0
      ? field.options.map((option) => ({
          value: field.type === 'string' ? option.value : JSON.stringify(option.value),
          label: option.label ?? String(option.value),
        }))
      : [
          { value: 'true', label: 'true' },
          { value: 'false', label: 'false' },
        ];

    for (const option of options) {
      const optionNode = document.createElement('option');
      optionNode.value = option.value;
      optionNode.textContent = option.label;
      control.append(optionNode);
    }
    control.value = currentValue ?? '';
  } else if (field.type === 'json') {
    control = document.createElement('textarea');
    control.placeholder = descriptor.defaultText || '{\n  "key": "value"\n}';
    control.value = currentValue ?? '';
  } else {
    control = document.createElement('input');
    control.type = field.type === 'integer' || field.type === 'number' ? 'number' : 'text';
    if (field.type === 'integer') {
      control.step = '1';
    }
    if (field.type === 'number') {
      control.step = 'any';
    }
    control.placeholder = field.default !== undefined ? String(field.default) : '';
    control.value = currentValue ?? '';
  }

  control.dataset.paramKey = field.key;
  wrapper.append(control);

  const noteParts = [];
  if (descriptor.help) noteParts.push(descriptor.help);
  if (field.default !== undefined) noteParts.push(`Bundle default: ${descriptor.defaultText}`);
  if (!field.required) noteParts.push('Blank values stay out of playlist.json');
  wrapper.append(createFieldNote(noteParts.join(' • ')));

  return wrapper;
}

function buildSchemaEditor(entry) {
  const shell = document.createElement('div');
  shell.className = 'entry-params-shell';

  const head = document.createElement('div');
  head.className = 'entry-params-head';

  const copy = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = 'Guided params';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Blank fields keep bundle defaults and are omitted from playlist.json.';
  copy.append(title, hint);

  const rawBtn = document.createElement('button');
  rawBtn.type = 'button';
  rawBtn.className = 'secondary-btn';
  rawBtn.dataset.action = 'use-raw';
  rawBtn.textContent = 'Edit raw JSON';
  head.append(copy, rawBtn);
  shell.append(head);

  if (entry.params_editor_message) {
    shell.append(createFieldNote(entry.params_editor_message));
  }

  const grid = document.createElement('div');
  grid.className = 'form-grid';
  for (const field of entry.params_schema.fields) {
    grid.append(buildSchemaControl(field, entry.params_form_values[field.key] ?? ''));
  }
  shell.append(grid);

  return shell;
}

function buildRawParamsEditor(entry) {
  const shell = document.createElement('div');
  shell.className = 'entry-params-shell';

  const head = document.createElement('div');
  head.className = 'entry-params-head';

  const copy = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = entry.params_schema ? 'Raw params JSON' : 'Params JSON';
  const hint = document.createElement('p');
  hint.className = 'hint';
  if (entry.params_schema) {
    hint.textContent = 'Bundle guidance is available, but this slide is currently using raw JSON editing.';
  } else if (entry.bundle_manifest_status === 'ready') {
    hint.textContent = 'This bundle does not advertise editable params, so raw JSON is the only option.';
  } else {
    hint.textContent = 'Edit params as raw JSON. Guided controls appear automatically when the bundle advertises them.';
  }
  copy.append(title, hint);
  head.append(copy);

  if (entry.params_schema) {
    const schemaBtn = document.createElement('button');
    schemaBtn.type = 'button';
    schemaBtn.className = 'secondary-btn';
    schemaBtn.dataset.action = 'use-schema';
    schemaBtn.textContent = 'Use guided fields';
    head.append(schemaBtn);
  }

  shell.append(head);

  if (entry.params_editor_message) {
    shell.append(createFieldNote(entry.params_editor_message, entry.params_schema ? 'warning' : ''));
  }

  const paramsField = document.createElement('label');
  paramsField.className = 'field is-wide';
  paramsField.innerHTML = '<span>Params JSON</span>';
  const paramsInput = document.createElement('textarea');
  paramsInput.dataset.field = 'params_text';
  paramsInput.placeholder = '{\n  "mode": "demo"\n}';
  paramsInput.value = entry.params_text;
  paramsField.append(paramsInput);
  shell.append(paramsField);

  return shell;
}

function renderEntries() {
  entryList.replaceChildren();

  for (const [index, entry] of state.editablePlaylist.slides.entries()) {
    ensureEntryEditorState(entry);

    const card = document.createElement('section');
    card.className = 'editor-entry';
    card.dataset.index = String(index);

    const topLine = document.createElement('div');
    topLine.className = 'entry-topline';

    const indexLabel = document.createElement('span');
    indexLabel.className = 'entry-index';
    indexLabel.textContent = `Slide ${index + 1}`;

    const actions = document.createElement('div');
    actions.className = 'entry-actions';

    const previewLink = document.createElement('a');
    previewLink.className = 'ghost-link';
    previewLink.href = entryPreviewHref(index);
    previewLink.textContent = 'Preview';

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'secondary-btn';
    reloadBtn.dataset.action = 'reload-manifest';
    reloadBtn.textContent = 'Reload metadata';
    reloadBtn.disabled = !String(entry.path ?? '').trim();

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'icon-btn';
    upBtn.dataset.action = 'move-up';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'icon-btn';
    downBtn.dataset.action = 'move-down';
    downBtn.textContent = '↓';
    downBtn.disabled = index === state.editablePlaylist.slides.length - 1;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn';
    removeBtn.dataset.action = 'remove';
    removeBtn.textContent = 'Remove';

    actions.append(previewLink, reloadBtn, upBtn, downBtn, removeBtn);
    topLine.append(indexLabel, actions);
    card.append(topLine, buildManifestSummary(entry));

    const grid = document.createElement('div');
    grid.className = 'form-grid';

    const pathField = document.createElement('label');
    pathField.className = 'field';
    pathField.innerHTML = `
      <span>Bundle path</span>
      <input data-field="path" value="${escapeHtml(entry.path)}" placeholder="clock.vzglyd" />
    `;
    pathField.append(createFieldNote('Repo-root-relative path inside the static slide root.'));

    const enabledField = document.createElement('label');
    enabledField.className = 'field';
    enabledField.innerHTML = `
      <span>Enabled</span>
      <select data-field="enabled">
        <option value="true"${entry.enabled ? ' selected' : ''}>true</option>
        <option value="false"${entry.enabled ? '' : ' selected'}>false</option>
      </select>
    `;

    const durationField = document.createElement('label');
    durationField.className = 'field';
    durationField.innerHTML = `
      <span>Duration seconds</span>
      <input data-field="duration_seconds" type="number" min="1" max="300" value="${escapeHtml(entry.duration_seconds)}" placeholder="inherit" />
    `;
    durationField.append(createFieldNote(describeInheritedDisplay(entry, 'duration_seconds')));

    const transitionInField = document.createElement('label');
    transitionInField.className = 'field';
    transitionInField.innerHTML = '<span>Transition in</span>';
    const transitionInSelect = document.createElement('select');
    transitionInSelect.dataset.field = 'transition_in';
    fillTransitionSelect(transitionInSelect, entry.transition_in);
    transitionInField.append(transitionInSelect, createFieldNote(describeInheritedDisplay(entry, 'transition_in')));

    const transitionOutField = document.createElement('label');
    transitionOutField.className = 'field';
    transitionOutField.innerHTML = '<span>Transition out</span>';
    const transitionOutSelect = document.createElement('select');
    transitionOutSelect.dataset.field = 'transition_out';
    fillTransitionSelect(transitionOutSelect, entry.transition_out);
    transitionOutField.append(transitionOutSelect, createFieldNote(describeInheritedDisplay(entry, 'transition_out')));

    grid.append(pathField, enabledField, durationField, transitionInField, transitionOutField);
    card.append(grid);

    if (entry.params_schema && entry.params_editor_mode === 'schema') {
      card.append(buildSchemaEditor(entry));
    } else {
      card.append(buildRawParamsEditor(entry));
    }

    entryList.append(card);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function syncJsonOutput() {
  if (!state.editablePlaylist) {
    state.renderedJson = '';
    jsonOutput.value = '';
    jsonStatus.textContent = 'Load a repo to begin editing.';
    syncControls();
    return;
  }

  try {
    const serialized = serializeEditablePlaylist(state.editablePlaylist);
    state.renderedJson = stringifyPlaylist(serialized);
    jsonOutput.value = state.renderedJson;
    jsonStatus.textContent = hasUnsavedChanges()
      ? 'playlist.json is valid. Export the updated file to commit these changes.'
      : 'playlist.json is valid and still matches the loaded source.';
  } catch (error) {
    state.renderedJson = '';
    jsonOutput.value = '';
    jsonStatus.textContent = error.message;
  }

  syncControls();
}

function renderEditor() {
  if (!state.editablePlaylist) {
    syncControls();
    return;
  }

  defaultDurationInput.value = state.editablePlaylist.defaults.duration_seconds;
  fillTransitionSelect(defaultTransitionIn, state.editablePlaylist.defaults.transition_in);
  fillTransitionSelect(defaultTransitionOut, state.editablePlaylist.defaults.transition_out);
  renderEntries();
  syncJsonOutput();
}

function syncEntryRawParamsFromSchema(entry) {
  if (!entry.params_schema || entry.params_editor_mode !== 'schema') {
    return;
  }

  try {
    const params = serializeParamsFromFormValues(entry.params_schema, entry.params_form_values, 'params');
    entry.params_text = params === undefined ? '' : JSON.stringify(params, null, 2);
  } catch {
    // Keep the previous raw JSON snapshot while the form is invalid.
  }
}

function switchEntryToSchema(entry) {
  if (!entry.params_schema) {
    return;
  }

  const params = parseParamsText(entry.params_text, 'params');
  entry.params_form_values = formValuesFromSchemaParams(entry.params_schema, params, 'params');
  entry.params_editor_mode = 'schema';
  entry.params_editor_message = '';
}

function switchEntryToRaw(entry) {
  syncEntryRawParamsFromSchema(entry);
  entry.params_editor_mode = 'raw';
  entry.params_editor_message = 'Editing raw JSON. Switch back to guided fields when the JSON matches the bundle schema.';
}

async function loadRepo() {
  try {
    hideError();
    setStatus('Fetching playlist.json...', true);
    const repo = await loadPlaylistFromRepo(repoUrlInput.value);

    state.repoBaseUrl = repo.repoBaseUrl;
    state.playlistUrl = repo.playlistUrl;
    state.loadedJson = stringifyPlaylist(repo.playlist);
    state.editablePlaylist = toEditablePlaylist(repo.playlist);
    state.renderedJson = state.loadedJson;

    for (const entry of state.editablePlaylist.slides) {
      ensureEntryEditorState(entry);
    }

    repoUrlInput.value = repo.repoBaseUrl;
    window.localStorage.setItem(REPO_STORAGE_KEY, repo.repoBaseUrl);
    renderEditor();
    await hydrateBundleMetadata();
  } catch (error) {
    showError(error.message);
    clearStatus();
  }
}

function moveEntry(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.editablePlaylist.slides.length) {
    return;
  }

  const [entry] = state.editablePlaylist.slides.splice(index, 1);
  state.editablePlaylist.slides.splice(target, 0, entry);
  renderEditor();
}

function updateEntryFieldFromTarget(entry, target) {
  if (target.dataset.paramKey) {
    entry.params_form_values[target.dataset.paramKey] = target.value;
    syncEntryRawParamsFromSchema(entry);
    syncJsonOutput();
    return;
  }

  const field = target.dataset.field;
  if (!field) {
    return;
  }

  if (field === 'enabled') {
    entry.enabled = target.value !== 'false';
  } else {
    entry[field] = target.value;
  }

  if (field === 'path') {
    resetEntryBundleState(entry, target.value.trim() ? 'idle' : 'idle');
  }

  syncJsonOutput();
}

function installHandlers() {
  repoForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void loadRepo();
  });

  addEntryBtn.addEventListener('click', () => {
    const entry = emptyEditableEntry();
    ensureEntryEditorState(entry);
    state.editablePlaylist.slides.push(entry);
    renderEditor();
  });

  defaultDurationInput.addEventListener('input', () => {
    state.editablePlaylist.defaults.duration_seconds = defaultDurationInput.value;
    syncJsonOutput();
  });

  defaultTransitionIn.addEventListener('change', () => {
    state.editablePlaylist.defaults.transition_in = defaultTransitionIn.value;
    syncJsonOutput();
    renderEntries();
  });

  defaultTransitionOut.addEventListener('change', () => {
    state.editablePlaylist.defaults.transition_out = defaultTransitionOut.value;
    syncJsonOutput();
    renderEntries();
  });

  entryList.addEventListener('input', (event) => {
    const target = event.target;
    const card = target.closest('.editor-entry');
    if (!card) return;

    const index = Number.parseInt(card.dataset.index ?? '', 10);
    const entry = state.editablePlaylist.slides[index];
    if (!entry) return;

    updateEntryFieldFromTarget(entry, target);
  });

  entryList.addEventListener('change', (event) => {
    const target = event.target;
    const card = target.closest('.editor-entry');
    if (!card) return;

    const index = Number.parseInt(card.dataset.index ?? '', 10);
    const entry = state.editablePlaylist.slides[index];
    if (!entry) return;

    updateEntryFieldFromTarget(entry, target);

    if (target.dataset.field === 'path') {
      void refreshEntryManifest(entry);
    }
  });

  entryList.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;

    const card = target.closest('.editor-entry');
    if (!card) return;

    const index = Number.parseInt(card.dataset.index ?? '', 10);
    const entry = state.editablePlaylist.slides[index];
    if (!entry) return;

    switch (target.dataset.action) {
      case 'move-up':
        moveEntry(index, -1);
        break;
      case 'move-down':
        moveEntry(index, 1);
        break;
      case 'remove':
        state.editablePlaylist.slides.splice(index, 1);
        renderEditor();
        break;
      case 'reload-manifest':
        void refreshEntryManifest(entry);
        break;
      case 'use-schema':
        try {
          switchEntryToSchema(entry);
          renderEditor();
        } catch (error) {
          showError(error.message);
        }
        break;
      case 'use-raw':
        switchEntryToRaw(entry);
        renderEditor();
        break;
      default:
        break;
    }
  });

  copyJsonBtn.addEventListener('click', async () => {
    if (!state.renderedJson) return;
    try {
      await navigator.clipboard.writeText(state.renderedJson);
      setStatus('playlist.json copied to clipboard.', false);
    } catch {
      showError('Clipboard copy failed');
    }
  });

  downloadJsonBtn.addEventListener('click', () => {
    if (!state.renderedJson) return;
    const blob = new Blob([state.renderedJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'playlist.json';
    link.click();
    URL.revokeObjectURL(url);
    setStatus('playlist.json downloaded.', false);
  });

  errorDismiss.addEventListener('click', hideError);
}

function boot() {
  setRepoSummary();
  fillTransitionSelect(defaultTransitionIn);
  fillTransitionSelect(defaultTransitionOut);
  updateLinks();
  installHandlers();
  syncControls();

  const requestedRepo = new URL(window.location.href).searchParams.get('repo')
    ?? window.localStorage.getItem(REPO_STORAGE_KEY);
  if (requestedRepo) {
    try {
      repoUrlInput.value = normalizeRepoBaseUrl(requestedRepo, window.location.href);
      void loadRepo();
    } catch {
      window.localStorage.removeItem(REPO_STORAGE_KEY);
    }
  }
}

boot();
