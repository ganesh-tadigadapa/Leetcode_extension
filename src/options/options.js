import { DEFAULT_SETTINGS, joinPath } from '../lib/format.js';

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

async function load() {
  const stored = await chrome.storage.local.get(['token', 'owner', 'repo', 'basePath', 'autoSync', 'connection']);
  $('owner').value = stored.owner || DEFAULT_SETTINGS.owner;
  $('repo').value = stored.repo || DEFAULT_SETTINGS.repo;
  $('basePath').value = stored.basePath ?? DEFAULT_SETTINGS.basePath;
  $('autoSync').checked = stored.autoSync ?? DEFAULT_SETTINGS.autoSync;
  $('token').value = '';
  $('token').placeholder = stored.token ? 'A token is saved — paste a new one to replace it' : 'github_pat_…';
  $('repo-hint').textContent = `${$('owner').value}/${$('repo').value}`;
  if (stored.token && stored.connection) showConnection(stored.connection);
}

function showConnection(c) {
  if (c.state === 'connected') {
    setStatus(`✓ Connected as @${c.login} to ${c.fullName} (branch: ${c.defaultBranch}).`, 'ok');
  } else if (c.state === 'error') {
    setStatus(`✗ ${c.message}`, 'err');
  } else {
    setStatus('Not connected.', 'warn');
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('token').value.trim();
  const owner = $('owner').value.trim();
  const repo = $('repo').value.trim();
  const basePath = joinPath($('basePath').value.trim());
  const update = { owner, repo, basePath, autoSync: $('autoSync').checked };

  if (token) {
    if (!/^(github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]+$/.test(token)) {
      setStatus('That does not look like a GitHub token.', 'err');
      return;
    }
    update.token = token;
  } else {
    const { token: existing } = await chrome.storage.local.get('token');
    if (!existing) {
      setStatus('Paste a GitHub token first.', 'err');
      return;
    }
  }

  const btn = e.submitter;
  btn.disabled = true;
  setStatus('Testing connection…');
  try {
    await chrome.storage.local.set(update);
    const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    if (!res?.ok) throw new Error(res?.error || 'Connection test failed');
    showConnection(res.result);
    if (res.result.state === 'connected' && token.startsWith('ghp_')) {
      setStatus(
        `${$('status').textContent} Note: this is a classic token with access to all your repos — a fine-grained token limited to ${owner}/${repo} is safer.`,
        'warn',
      );
    }
    $('token').value = '';
    $('token').placeholder = 'A token is saved — paste a new one to replace it';
    $('repo-hint').textContent = `${owner}/${repo}`;
  } catch (err) {
    setStatus(`✗ ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token']);
  await chrome.storage.local.set({ connection: { state: 'disconnected', checkedAt: Date.now() } });
  $('token').placeholder = 'github_pat_…';
  setStatus('Token removed. Remember to also revoke it on GitHub if you no longer need it.', 'warn');
});

load();
