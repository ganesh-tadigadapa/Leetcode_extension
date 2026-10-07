import {
  DEFAULT_SETTINGS,
  planUpload,
  toBase64Utf8,
  ensureTrailingNewline,
} from './lib/format.js';
import * as github from './lib/github.js';

const SYNCED_KEY = 'syncedSubmissions';
const MAX_SYNCED = 500;
const tabKey = (tabId) => `tab:${tabId}`;

// ---------- settings / persistent state ----------

async function getSettings() {
  const stored = await chrome.storage.local.get(['token', 'owner', 'repo', 'basePath', 'autoSync']);
  const settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(stored)) if (v !== undefined && v !== '') settings[k] = v;
  return settings;
}

async function getSyncedMap() {
  return (await chrome.storage.local.get(SYNCED_KEY))[SYNCED_KEY] || {};
}

async function markSynced(submissionId, result) {
  const map = await getSyncedMap();
  map[submissionId] = { ...result, at: Date.now() };
  const ids = Object.keys(map);
  if (ids.length > MAX_SYNCED) {
    ids.sort((a, b) => map[a].at - map[b].at).slice(0, ids.length - MAX_SYNCED).forEach((id) => delete map[id]);
  }
  await chrome.storage.local.set({ [SYNCED_KEY]: map });
}

// ---------- per-tab state (chrome.storage.session, survives service-worker restarts) ----------

let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function readTab(tabId) {
  const key = tabKey(tabId);
  return (await chrome.storage.session.get(key))[key] || { problem: null, submission: null, sync: null };
}

function updateTab(tabId, updater) {
  return serialized(async () => {
    const current = await readTab(tabId);
    const next = { ...current, ...updater(current), updatedAt: Date.now() };
    await chrome.storage.session.set({ [tabKey(tabId)]: next });
    return next;
  });
}

async function setBadge(tabId, sync) {
  const map = {
    uploading: ['…', '#6b7280'],
    uploaded: ['✓', '#16a34a'],
    duplicate: ['!', '#d97706'],
    error: ['×', '#dc2626'],
  };
  const [text, color] = (sync && map[sync.state]) || ['', '#000000'];
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // tab may be gone
  }
}

async function setSync(tabId, sync) {
  await updateTab(tabId, () => ({ sync }));
  await setBadge(tabId, sync);
}

// ---------- GitHub connection ----------

async function testConnection() {
  const settings = await getSettings();
  let connection;
  if (!settings.token) {
    connection = { state: 'disconnected', checkedAt: Date.now() };
  } else {
    try {
      const info = await github.verifyConnection(settings.token, settings.owner, settings.repo);
      connection = { state: 'connected', ...info, checkedAt: Date.now() };
      if (info.canPush === false) {
        connection = { state: 'error', message: `@${info.login} has no write access to ${info.fullName}.`, checkedAt: Date.now() };
      }
    } catch (e) {
      connection = { state: 'error', message: e.message, checkedAt: Date.now() };
    }
  }
  await chrome.storage.local.set({ connection });
  return connection;
}

// ---------- upload ----------

const inFlight = new Set();

async function upload(tabId, { categoryOverride = '', auto = false } = {}) {
  const state = await readTab(tabId);
  const submission = state.submission;
  const problem = submission?.problem || state.problem;

  if (!submission || submission.status !== 'Accepted' || !submission.code) {
    throw new Error('No Accepted submission with code on this tab yet.');
  }
  if (inFlight.has(submission.id)) return;

  const settings = await getSettings();
  if (!settings.token) {
    await setSync(tabId, { state: 'error', message: 'GitHub is not connected. Open Settings and add a token.', submissionId: submission.id });
    return;
  }

  let plan;
  try {
    plan = planUpload({ problem, submission, settings, categoryOverride });
  } catch (e) {
    await setSync(tabId, { state: 'error', message: e.message, submissionId: submission.id });
    return;
  }

  inFlight.add(submission.id);
  await setSync(tabId, { state: 'uploading', path: plan.path, auto, submissionId: submission.id });
  try {
    const { token, owner, repo } = settings;
    const repoInfo = await github.getRepo(token, owner, repo);
    const branch = repoInfo.default_branch;

    const existing = await github.findExistingSolution(token, owner, repo, branch, plan);
    if (existing) {
      const result = { state: 'duplicate', path: existing.path, url: existing.htmlUrl, submissionId: submission.id };
      await setSync(tabId, result);
      await markSynced(submission.id, result);
      return;
    }

    const created = await github.createFile(token, owner, repo, branch, {
      path: plan.path,
      contentBase64: toBase64Utf8(ensureTrailingNewline(submission.code)),
      message: plan.message,
    });
    const result = {
      state: 'uploaded',
      path: created.path,
      url: created.htmlUrl,
      commitUrl: created.commitUrl,
      auto,
      submissionId: submission.id,
    };
    await setSync(tabId, result);
    await markSynced(submission.id, result);
  } catch (e) {
    if (e.duplicate) {
      const result = { state: 'duplicate', path: plan.path, url: null, submissionId: submission.id };
      await setSync(tabId, result);
      await markSynced(submission.id, result);
    } else {
      await setSync(tabId, { state: 'error', message: e.message, path: plan.path, submissionId: submission.id });
    }
  } finally {
    inFlight.delete(submission.id);
  }
}

// ---------- messages from content script ----------

async function onProblem(tabId, problem) {
  const prev = await readTab(tabId);
  const changed = (prev.problem?.titleSlug || null) !== (problem?.titleSlug || null);
  await updateTab(tabId, () => (changed ? { problem, submission: null, sync: null } : { problem }));
  if (changed) await setBadge(tabId, null);
}

async function onSubmissionStatus(tabId, msg) {
  await updateTab(tabId, (cur) => {
    if (cur.submission?.id === msg.submissionId && cur.submission.status === 'Accepted' && cur.submission.code) {
      return {}; // never downgrade a fully loaded accepted submission
    }
    return {
      submission: {
        id: msg.submissionId,
        slug: msg.slug || cur.problem?.titleSlug || null,
        status: msg.status,
        lang: msg.lang || null,
        error: msg.error || null,
      },
      sync: cur.sync?.submissionId === msg.submissionId ? cur.sync : null,
    };
  });
}

async function onAccepted(tabId, { submission, problem }) {
  await updateTab(tabId, (cur) => ({
    problem: problem && (!cur.problem || cur.problem.titleSlug === problem.titleSlug) ? problem : cur.problem,
    submission: { ...submission, status: 'Accepted', problem },
    sync: cur.sync?.submissionId === submission.id ? cur.sync : null,
  }));

  const synced = (await getSyncedMap())[submission.id];
  if (synced) {
    await setSync(tabId, synced);
    return;
  }

  const settings = await getSettings();
  if (submission.live && settings.autoSync && settings.token) {
    await upload(tabId, { auto: true });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromTab = sender.tab?.id;
  let work;
  switch (msg?.type) {
    // content script -> background
    case 'PROBLEM':
      if (fromTab != null) work = onProblem(fromTab, msg.problem);
      break;
    case 'SUBMISSION_STATUS':
      if (fromTab != null) work = onSubmissionStatus(fromTab, msg);
      break;
    case 'ACCEPTED':
      if (fromTab != null) work = onAccepted(fromTab, msg);
      break;
    // popup / options -> background
    case 'UPLOAD':
      work = upload(msg.tabId, { categoryOverride: msg.category || '', auto: false });
      break;
    case 'TEST_CONNECTION':
      work = testConnection();
      break;
    default:
      return false;
  }
  if (!work) return false;
  work.then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
  );
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialized(() => chrome.storage.session.remove(tabKey(tabId)));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.token || changes.owner || changes.repo) testConnection();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (current[k] === undefined) missing[k] = v;
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);

  const { token } = await chrome.storage.local.get('token');
  if (reason === 'install' && !token) chrome.runtime.openOptionsPage();
  else testConnection();
});
