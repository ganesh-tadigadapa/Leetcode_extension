// End-to-end test of the service worker logic with an in-memory chrome.* and a fake GitHub API.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------- fake chrome ----------
function makeArea(name, listeners) {
  let data = {};
  return {
    _reset() { data = {}; },
    async get(keys) {
      if (keys == null) return { ...data };
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data[k], newValue: v };
        data[k] = structuredClone(v);
      }
      listeners.forEach((l) => l(changes, name));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}
const storageListeners = [];
const messageListeners = [];
const badges = {};
globalThis.chrome = {
  storage: {
    local: makeArea('local', storageListeners),
    session: makeArea('session', storageListeners),
    onChanged: { addListener: (l) => storageListeners.push(l) },
  },
  runtime: {
    onMessage: { addListener: (l) => messageListeners.push(l) },
    onInstalled: { addListener: () => {} },
    openOptionsPage: () => {},
  },
  tabs: { onRemoved: { addListener: () => {} } },
  action: {
    setBadgeText: async ({ tabId, text }) => { badges[tabId] = text; },
    setBadgeBackgroundColor: async () => {},
  },
};

function send(msg, tabId) {
  return new Promise((resolve) => {
    const sender = tabId != null ? { tab: { id: tabId } } : {};
    for (const l of messageListeners) l(msg, sender, resolve);
  });
}

// ---------- fake GitHub ----------
let repoFiles; // path -> content
let requests;
globalThis.fetch = async (url, init = {}) => {
  const method = init.method || 'GET';
  const u = new URL(url);
  requests.push({ method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  if (init.headers?.Authorization !== 'Bearer github_pat_TEST') return json(401, { message: 'Bad credentials' });
  if (u.pathname === '/user') return json(200, { login: 'ganesh-tadigadapa' });
  if (u.pathname === '/repos/ganesh-tadigadapa/DSA_007') {
    return json(200, { full_name: 'ganesh-tadigadapa/DSA_007', default_branch: 'main', private: false, permissions: { push: true }, html_url: 'https://github.com/ganesh-tadigadapa/DSA_007' });
  }
  if (u.pathname === '/repos/ganesh-tadigadapa/DSA_007/git/trees/main') {
    return json(200, { truncated: false, tree: Object.keys(repoFiles).map((path) => ({ path, type: 'blob' })) });
  }
  const m = u.pathname.match(/^\/repos\/ganesh-tadigadapa\/DSA_007\/contents\/(.+)$/);
  if (m && method === 'PUT') {
    const path = decodeURIComponent(m[1]);
    const body = JSON.parse(init.body);
    if (repoFiles[path] && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
    repoFiles[path] = Buffer.from(body.content, 'base64').toString('utf8');
    return json(201, {
      content: { path, html_url: `https://github.com/ganesh-tadigadapa/DSA_007/blob/main/${path}` },
      commit: { sha: 'abc123', html_url: 'https://github.com/ganesh-tadigadapa/DSA_007/commit/abc123' },
    });
  }
  return json(404, { message: 'Not Found' });
};

await import('../src/background.js');

const problem = {
  questionId: '283',
  questionFrontendId: '283',
  title: 'Move Zeroes',
  titleSlug: 'move-zeroes',
  difficulty: 'Easy',
  topicTags: [{ name: 'Array', slug: 'array' }, { name: 'Two Pointers', slug: 'two-pointers' }],
};
const code = 'class Solution {\npublic:\n    void moveZeroes(vector<int>& nums) {}\n};';
const TAB = 7;
const tabState = async () => (await chrome.storage.session.get(`tab:${TAB}`))[`tab:${TAB}`];
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  chrome.storage.local._reset();
  chrome.storage.session._reset();
  repoFiles = { 'README.md': '# DSA_007' };
  requests = [];
  await chrome.storage.local.set({ owner: 'ganesh-tadigadapa', repo: 'DSA_007', basePath: 'LeetCode', autoSync: true, token: 'github_pat_TEST' });
  await settle();
  requests = [];
});

test('connection test reports the GitHub user and repo', async () => {
  const res = await send({ type: 'TEST_CONNECTION' });
  assert.equal(res.ok, true);
  assert.equal(res.result.state, 'connected');
  assert.equal(res.result.login, 'ganesh-tadigadapa');
  assert.equal(res.result.fullName, 'ganesh-tadigadapa/DSA_007');
});

test('auto-sync: Accepted submission is committed to LeetCode/Arrays/283_Move_Zeroes.cpp', async () => {
  await send({ type: 'PROBLEM', problem }, TAB);
  await send({ type: 'SUBMISSION_STATUS', submissionId: '111', slug: 'move-zeroes', status: 'Judging…', lang: 'cpp' }, TAB);
  await send({ type: 'ACCEPTED', submission: { id: '111', slug: 'move-zeroes', lang: 'cpp', code, live: true }, problem }, TAB);

  assert.equal(repoFiles['LeetCode/Arrays/283_Move_Zeroes.cpp'], `${code}\n`);
  const put = requests.find((r) => r.method === 'PUT');
  assert.equal(put.body.message, 'Add LeetCode: 283 Move Zeroes');
  assert.equal(put.body.sha, undefined, 'must never send sha (no overwrite)');
  assert.equal(put.body.branch, 'main');
  const state = await tabState();
  assert.equal(state.sync.state, 'uploaded');
  assert.equal(state.sync.path, 'LeetCode/Arrays/283_Move_Zeroes.cpp');
  assert.equal(badges[TAB], '✓');
});

test('duplicate: existing solution (even in another folder) is not overwritten', async () => {
  repoFiles['LeetCode/Two_Pointers/283_Move_Zeroes.cpp'] = 'old';
  await send({ type: 'PROBLEM', problem }, TAB);
  await send({ type: 'ACCEPTED', submission: { id: '222', slug: 'move-zeroes', lang: 'cpp', code, live: true }, problem }, TAB);

  assert.equal(repoFiles['LeetCode/Two_Pointers/283_Move_Zeroes.cpp'], 'old');
  assert.equal(repoFiles['LeetCode/Arrays/283_Move_Zeroes.cpp'], undefined);
  assert.ok(!requests.some((r) => r.method === 'PUT'));
  const state = await tabState();
  assert.equal(state.sync.state, 'duplicate');
  assert.equal(state.sync.path, 'LeetCode/Two_Pointers/283_Move_Zeroes.cpp');
});

test('same problem in a different language is a separate file', async () => {
  repoFiles['LeetCode/Arrays/283_Move_Zeroes.cpp'] = 'old';
  await send({ type: 'PROBLEM', problem }, TAB);
  await send({ type: 'ACCEPTED', submission: { id: '333', slug: 'move-zeroes', lang: 'python3', code: 'class Solution: pass', live: true }, problem }, TAB);
  assert.equal(repoFiles['LeetCode/Arrays/283_Move_Zeroes.py'], 'class Solution: pass\n');
});

test('auto-sync OFF: nothing uploads until the popup Upload button is used (with custom folder)', async () => {
  await chrome.storage.local.set({ autoSync: false });
  await send({ type: 'PROBLEM', problem }, TAB);
  await send({ type: 'ACCEPTED', submission: { id: '444', slug: 'move-zeroes', lang: 'java', code: 'class Solution {}', live: true }, problem }, TAB);
  assert.ok(!requests.some((r) => r.method === 'PUT'));
  assert.equal((await tabState()).sync, null);

  const res = await send({ type: 'UPLOAD', tabId: TAB, category: 'Two_Pointers' });
  assert.equal(res.ok, true);
  assert.equal(repoFiles['LeetCode/Two_Pointers/283_Move_Zeroes.java'], 'class Solution {}\n');
});

test('old submissions (not live) are not auto-synced', async () => {
  await send({ type: 'PROBLEM', problem }, TAB);
  await send({ type: 'ACCEPTED', submission: { id: '555', slug: 'move-zeroes', lang: 'cpp', code, live: false }, problem }, TAB);
  assert.ok(!requests.some((r) => r.method === 'PUT'));
});

test('a submission already synced is not uploaded twice', async () => {
  await send({ type: 'PROBLEM', problem }, TAB);
  await send({ type: 'ACCEPTED', submission: { id: '666', slug: 'move-zeroes', lang: 'typescript', code: 'x', live: true }, problem }, TAB);
  const puts = requests.filter((r) => r.method === 'PUT').length;
  await send({ type: 'ACCEPTED', submission: { id: '666', slug: 'move-zeroes', lang: 'typescript', code: 'x', live: true }, problem }, TAB);
  assert.equal(requests.filter((r) => r.method === 'PUT').length, puts);
  assert.equal((await tabState()).sync.state, 'uploaded');
});

test('unsupported language and missing token give clear errors', async () => {
  await send({ type: 'PROBLEM', problem }, TAB);
  await send({ type: 'ACCEPTED', submission: { id: '777', slug: 'move-zeroes', lang: 'golang', code: 'package main', live: true }, problem }, TAB);
  assert.match((await tabState()).sync.message, /Unsupported language/);

  await chrome.storage.local.remove('token');
  await send({ type: 'ACCEPTED', submission: { id: '888', slug: 'move-zeroes', lang: 'cpp', code, live: true }, problem }, TAB);
  const res = await send({ type: 'UPLOAD', tabId: TAB });
  assert.equal(res.ok, true);
  assert.match((await tabState()).sync.message, /not connected/i);
});

test('bad token surfaces a readable GitHub error', async () => {
  await chrome.storage.local.set({ token: 'github_pat_WRONG' });
  await settle();
  const res = await send({ type: 'TEST_CONNECTION' });
  assert.equal(res.result.state, 'error');
  assert.match(res.result.message, /rejected the token/);
});
