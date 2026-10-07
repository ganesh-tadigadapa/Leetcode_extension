// Runs interceptor.js (MAIN world) and content.js (isolated world) in separate VM contexts that
// mimic Chrome's two worlds, then replays LeetCode's submit -> check network flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const src = (p) => readFileSync(new URL(`../src/content/${p}`, import.meta.url), 'utf8');
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setup({ submissionStatusCode = 10, pathname = '/problems/move-zeroes/description/', resultText = null } = {}) {
  const location = { origin: 'https://leetcode.com', href: `https://leetcode.com${pathname}`, pathname };
  const messageListeners = [];
  const sent = [];
  const gqlCalls = [];

  // ----- isolated world (content.js) -----
  const contentWindow = {};
  const contentCtx = {
    window: contentWindow,
    location,
    document: {
      cookie: 'csrftoken=tok123; other=1',
      querySelector: (sel) => (sel === '[data-e2e-locator="submission-result"]' && resultText ? { textContent: resultText } : null),
    },
    chrome: {
      runtime: {
        sendMessage: async (m) => { sent.push(m); },
        onMessage: { addListener: () => {} },
      },
    },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      gqlCalls.push({ url, body, headers: init.headers });
      if (body.operationName === 'dsa007Question') {
        return json({ data: { question: { questionId: '283', questionFrontendId: '283', title: 'Move Zeroes', titleSlug: 'move-zeroes', difficulty: 'Easy', topicTags: [{ name: 'Array', slug: 'array' }, { name: 'Two Pointers', slug: 'two-pointers' }] } } });
      }
      if (body.operationName === 'dsa007SubmissionDetails') {
        return json({ data: { submissionDetails: { code: 'SERVER CODE', timestamp: Math.floor(Date.now() / 1000), statusCode: submissionStatusCode, lang: { name: 'cpp', verboseName: 'C++' }, question: { questionId: '283', titleSlug: 'move-zeroes' } } } });
      }
      throw new Error('unexpected');
    },
    setInterval: (...a) => setInterval(...a).unref(),
    setTimeout, clearInterval, Promise, JSON, Number, Date, Error, Map, Set, String, decodeURIComponent,
  };
  contentWindow.addEventListener = (type, fn) => { if (type === 'message') messageListeners.push(fn); };
  vm.createContext(contentCtx);

  // ----- page / MAIN world (interceptor.js) -----
  class FakeXHR {
    open(method, url) { this.url = url; }
    send() {}
    addEventListener() {}
  }
  const pageCtx = {
    location,
    URL, Request, Response, Promise, JSON, String, Object,
    XMLHttpRequest: FakeXHR,
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/submit/')) return json({ submission_id: 111 });
      if (url.includes('/check/')) return json({ state: 'SUCCESS', status_code: submissionStatusCode, status_msg: submissionStatusCode === 10 ? 'Accepted' : 'Wrong Answer', lang: 'cpp' });
      return json({});
    },
    postMessage: (data, origin) => {
      assert.equal(origin, 'https://leetcode.com');
      for (const fn of messageListeners) fn({ source: contentWindow, origin: location.origin, data: structuredClone(data) });
    },
  };
  pageCtx.window = pageCtx;
  vm.createContext(pageCtx);

  vm.runInContext(src('interceptor.js'), pageCtx);
  vm.runInContext(src('content.js'), contentCtx);
  return { pageCtx, contentWindow, messageListeners, sent, gqlCalls, location };
}

test('detects current problem with tags', async () => {
  const { sent, gqlCalls } = setup();
  await wait(20);
  const p = sent.find((m) => m.type === 'PROBLEM');
  assert.equal(p.problem.title, 'Move Zeroes');
  assert.equal(p.problem.questionFrontendId, '283');
  assert.deepEqual(p.problem.topicTags.map((t) => t.slug), ['array', 'two-pointers']);
  assert.equal(gqlCalls[0].headers['x-csrftoken'], 'tok123');
});

test('submit + Accepted check -> ACCEPTED with server-side code, live', async () => {
  const { pageCtx, sent } = setup();
  await pageCtx.fetch('/problems/move-zeroes/submit/', { method: 'POST', body: JSON.stringify({ lang: 'cpp', question_id: '283', typed_code: 'TYPED CODE' }) });
  await wait(10);
  await pageCtx.fetch('https://leetcode.com/submissions/detail/111/check/');
  await wait(50);

  assert.ok(sent.some((m) => m.type === 'SUBMISSION_STATUS' && m.status === 'Judging…' && m.submissionId === '111'));
  const acc = sent.find((m) => m.type === 'ACCEPTED');
  assert.ok(acc, 'ACCEPTED sent');
  assert.equal(acc.submission.id, '111');
  assert.equal(acc.submission.code, 'SERVER CODE');
  assert.equal(acc.submission.lang, 'cpp');
  assert.equal(acc.submission.live, true);
  assert.equal(acc.problem.title, 'Move Zeroes');
});

test('Wrong Answer is reported as status, never as ACCEPTED', async () => {
  const { pageCtx, sent } = setup({ submissionStatusCode: 11 });
  await pageCtx.fetch(new Request('https://leetcode.com/problems/move-zeroes/submit/', { method: 'POST', body: '{"lang":"cpp","typed_code":"x"}' }));
  await pageCtx.fetch('/submissions/detail/111/check/');
  await wait(50);
  assert.ok(sent.some((m) => m.type === 'SUBMISSION_STATUS' && m.status === 'Wrong Answer'));
  assert.ok(!sent.some((m) => m.type === 'ACCEPTED'));
});

test('forged page message claiming Accepted is ignored when LeetCode says otherwise', async () => {
  const { pageCtx, sent } = setup({ submissionStatusCode: 11 });
  pageCtx.postMessage({ source: 'dsa007-interceptor', kind: 'check', submissionId: '999', statusCode: 10, statusMsg: 'Accepted' }, 'https://leetcode.com');
  await wait(50);
  assert.ok(!sent.some((m) => m.type === 'ACCEPTED'));
});

test('DOM fallback: Accepted result panel on a submission URL', async () => {
  const { sent } = setup({ pathname: '/problems/move-zeroes/submissions/4242/', resultText: ' Accepted ' });
  await wait(50);
  const acc = sent.find((m) => m.type === 'ACCEPTED');
  assert.ok(acc);
  assert.equal(acc.submission.id, '4242');
  assert.equal(acc.submission.live, true, 'fresh timestamp counts as live');
});

test('run-code checks (non-numeric ids) are ignored', async () => {
  const { pageCtx, sent } = setup();
  await pageCtx.fetch('/submissions/detail/runcode_1700000000.1_abc/check/');
  await wait(30);
  assert.ok(!sent.some((m) => m.type === 'SUBMISSION_STATUS' || m.type === 'ACCEPTED'));
});
