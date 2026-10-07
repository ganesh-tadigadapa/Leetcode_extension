import { DEFAULT_SETTINGS, CATEGORY_SUGGESTIONS, categorize, planUpload, getLanguage } from '../lib/format.js';

const $ = (id) => document.getElementById(id);

let tabId = null;
let contentScriptReady = false;
let categoryEditedFor = null; // submission id the user typed a custom category for

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  if (text != null) node.textContent = text;
  return node;
}

function renderConnection(settings, connection) {
  const dot = $('gh-dot');
  const text = $('gh-text');
  dot.className = 'dot';
  text.replaceChildren();
  if (!settings.token) {
    dot.classList.add('err');
    text.append(el('a', { href: '#', id: 'connect-link' }, 'Not connected — set up'));
    $('connect-link').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  if (!connection || connection.state === 'disconnected') {
    text.textContent = 'Checking…';
  } else if (connection.state === 'connected') {
    dot.classList.add('ok');
    text.textContent = `@${connection.login} → ${connection.fullName}`;
  } else {
    dot.classList.add('err');
    text.textContent = connection.message || 'Connection error';
    text.title = connection.message || '';
  }
}

function renderProblem(problem) {
  const box = $('problem');
  const tags = $('tags');
  tags.replaceChildren();
  box.replaceChildren();
  box.className = 'value';
  if (!contentScriptReady) {
    box.classList.add('muted');
    box.textContent = 'Open a problem on leetcode.com (reload the tab if it was open before the extension was loaded).';
    return;
  }
  if (!problem) {
    box.classList.add('muted');
    box.textContent = 'Open a problem on leetcode.com';
    return;
  }
  if (problem.error || !problem.title) {
    box.textContent = problem.error ? `${problem.titleSlug}: ${problem.error}` : `Loading ${problem.titleSlug}…`;
    return;
  }
  box.append(`${problem.questionFrontendId}. ${problem.title} `);
  if (problem.difficulty) box.append(el('span', { className: `diff-${problem.difficulty}` }, `· ${problem.difficulty}`));
  for (const t of problem.topicTags || []) tags.append(el('span', { className: 'tag' }, t.name));
  if ((problem.topicTags || []).length) {
    tags.append(el('span', { className: 'tag', title: 'Auto-detected folder' }, `→ ${categorize(problem.topicTags)}`));
  }
}

function renderSubmission(submission) {
  const box = $('submission');
  box.replaceChildren();
  box.className = 'value';
  if (!submission) {
    box.classList.add('muted');
    box.textContent = 'No submission yet';
    return;
  }
  const status = submission.status || 'Unknown';
  const good = status === 'Accepted';
  const pending = /judging/i.test(status);
  box.append(el('span', { className: good ? 'status-Accepted' : pending ? '' : 'status-bad' }, status));
  const lang = getLanguage(submission.lang);
  if (submission.lang) box.append(` · ${lang ? lang.label : submission.lang}`);
  if (submission.id) box.append(el('span', { className: 'muted' }, ` · #${submission.id}`));
  if (good && !submission.code && !submission.error) box.append(el('div', { className: 'muted' }, 'Loading code…'));
  if (submission.error) box.append(el('div', { className: 'status-bad' }, submission.error));
  if (good && submission.code && !lang) {
    box.append(el('div', { className: 'status-bad' }, 'This language is not supported (C++, Python, Java, JavaScript, TypeScript).'));
  }
}

function renderTarget(state, settings) {
  const block = $('target-block');
  const sub = state.submission;
  const problem = sub?.problem || state.problem;
  let plan = null;
  if (sub?.status === 'Accepted' && sub.code && problem?.title) {
    try {
      plan = planUpload({ problem, submission: sub, settings });
    } catch {
      plan = null;
    }
  }
  block.hidden = !plan;
  if (!plan) return null;
  $('path-base').textContent = plan.basePath;
  $('path-file').textContent = plan.filename;
  const input = $('category');
  if (categoryEditedFor !== sub.id && document.activeElement !== input) input.value = plan.category;
  const locked = ['uploading', 'uploaded', 'duplicate'].includes(state.sync?.state);
  input.disabled = locked;
  return plan;
}

function renderSync(sync) {
  const box = $('sync');
  box.replaceChildren();
  box.className = 'notice';
  if (!sync) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
  switch (sync.state) {
    case 'uploading':
      box.append(`Uploading ${sync.path}…`);
      break;
    case 'uploaded':
      box.classList.add('ok');
      box.append(`✓ ${sync.auto ? 'Auto-synced' : 'Uploaded'}: `);
      box.append(sync.url ? link(sync.url, sync.path) : sync.path);
      if (sync.commitUrl) box.append(' · ', link(sync.commitUrl, 'commit'));
      break;
    case 'duplicate':
      box.classList.add('warn');
      box.append('⚠ Duplicate: a solution already exists at ');
      box.append(sync.url ? link(sync.url, sync.path) : sync.path);
      box.append('. It was NOT overwritten.');
      break;
    case 'error':
      box.classList.add('err');
      box.append(`Upload failed: ${sync.message}`);
      break;
    default:
      box.hidden = true;
  }
}

function renderUploadButton(state, settings, plan) {
  const btn = $('upload');
  const syncState = state.sync?.state;
  btn.textContent =
    syncState === 'uploading' ? 'Uploading…'
      : syncState === 'uploaded' ? 'Uploaded ✓'
        : syncState === 'duplicate' ? 'Already in repo'
          : syncState === 'error' ? 'Retry upload'
            : 'Upload to GitHub';
  btn.disabled = !settings.token || !plan || ['uploading', 'uploaded', 'duplicate'].includes(syncState);
}

async function render() {
  const local = await chrome.storage.local.get(['token', 'owner', 'repo', 'basePath', 'autoSync', 'connection']);
  const settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(local)) if (v !== undefined && v !== '') settings[k] = v;

  const key = `tab:${tabId}`;
  const state = (tabId != null && (await chrome.storage.session.get(key))[key]) || {};

  renderConnection(settings, local.connection);
  $('auto-sync').checked = Boolean(settings.autoSync);
  renderProblem(state.problem);
  renderSubmission(state.submission);
  const plan = renderTarget(state, settings);
  renderSync(state.sync);
  renderUploadButton(state, settings, plan);
}

async function init() {
  const datalist = $('category-list');
  for (const c of CATEGORY_SUGGESTIONS) datalist.append(el('option', { value: c }));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'REFRESH' });
      contentScriptReady = true;
    } catch {
      contentScriptReady = false;
    }
  }

  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('auto-sync').addEventListener('change', (e) => chrome.storage.local.set({ autoSync: e.target.checked }));
  $('category').addEventListener('input', async () => {
    const key = `tab:${tabId}`;
    const state = (await chrome.storage.session.get(key))[key];
    categoryEditedFor = state?.submission?.id ?? null;
  });
  $('upload').addEventListener('click', async () => {
    const btn = $('upload');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    const res = await chrome.runtime.sendMessage({ type: 'UPLOAD', tabId, category: $('category').value.trim() });
    await render();
    if (res && !res.ok) renderSync({ state: 'error', message: res.error });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' || (area === 'session' && changes[`tab:${tabId}`])) render();
  });

  await render();
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }).catch(() => {});
}

init();
