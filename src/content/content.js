// Isolated-world content script on leetcode.com.
// - Tracks the current problem (LeetCode is a SPA, so the URL is polled).
// - Receives submit/check events from interceptor.js (MAIN world).
// - On "Accepted", loads the authoritative code/language from LeetCode's GraphQL API and
//   hands everything to the service worker, which does the GitHub upload.
(() => {
  const INTERCEPTOR = 'dsa007-interceptor';
  const ACCEPTED = 10; // LeetCode status_code for Accepted
  const LIVE_WINDOW_SEC = 5 * 60; // DOM-detected submissions newer than this count as "just submitted"

  const problemCache = new Map(); // slug -> Promise<problem>
  const capturedSubmits = new Map(); // submissionId -> { slug, lang, code }
  const handled = new Set(); // submission ids already processed as Accepted

  let currentSlug = null;
  let lastHref = '';
  let alive = true;

  function send(message) {
    if (!alive) return;
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // Extension was reloaded/removed: this script is orphaned. Stop doing work.
      alive = false;
    }
  }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function graphql(operationName, query, variables) {
    const res = await fetch('https://leetcode.com/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrftoken': csrfToken() },
      body: JSON.stringify({ operationName, query, variables }),
    });
    if (!res.ok) throw new Error(`LeetCode API HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message || 'LeetCode API error');
    return json.data;
  }

  const QUESTION_QUERY = `
    query dsa007Question($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionId
        questionFrontendId
        title
        titleSlug
        difficulty
        topicTags { name slug }
      }
    }`;

  const SUBMISSION_QUERY = `
    query dsa007SubmissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        code
        timestamp
        statusCode
        lang { name verboseName }
        question { questionId titleSlug }
      }
    }`;

  function fetchProblem(slug) {
    if (!problemCache.has(slug)) {
      const p = graphql('dsa007Question', QUESTION_QUERY, { titleSlug: slug }).then((data) => {
        if (!data?.question) throw new Error(`Problem "${slug}" not found`);
        return data.question;
      });
      p.catch(() => problemCache.delete(slug));
      problemCache.set(slug, p);
    }
    return problemCache.get(slug);
  }

  async function fetchSubmission(id) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const data = await graphql('dsa007SubmissionDetails', SUBMISSION_QUERY, { submissionId: Number(id) });
        if (data?.submissionDetails?.code != null) return data.submissionDetails;
        lastError = new Error('Submission details not available yet');
      } catch (e) {
        lastError = e;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    throw lastError;
  }

  function slugFromPath(pathname) {
    const m = pathname.match(/^\/problems\/([^/]+)/);
    return m ? m[1] : null;
  }

  async function announceProblem(slug) {
    if (!slug) {
      send({ type: 'PROBLEM', problem: null });
      return;
    }
    try {
      const problem = await fetchProblem(slug);
      if (slug !== currentSlug) return;
      send({ type: 'PROBLEM', problem });
    } catch (e) {
      if (slug !== currentSlug) return;
      send({ type: 'PROBLEM', problem: { titleSlug: slug, error: e.message } });
    }
  }

  async function processAccepted(id, { viaDom }) {
    if (handled.has(id)) return;
    handled.add(id);
    send({ type: 'SUBMISSION_STATUS', submissionId: id, slug: currentSlug, status: 'Accepted' });

    let code;
    let lang;
    let slug;
    let timestamp = null;
    try {
      const details = await fetchSubmission(id);
      if (details.statusCode !== ACCEPTED) return; // DOM/network said Accepted but server disagrees
      code = details.code;
      lang = details.lang?.name;
      slug = details.question?.titleSlug;
      timestamp = Number(details.timestamp) || null;
    } catch (e) {
      const captured = capturedSubmits.get(id);
      if (!captured?.code) {
        handled.delete(id);
        send({
          type: 'SUBMISSION_STATUS',
          submissionId: id,
          slug: currentSlug,
          status: 'Accepted',
          error: `Could not load submission code from LeetCode: ${e.message}`,
        });
        return;
      }
      ({ code, lang, slug } = captured);
    }

    slug = slug || capturedSubmits.get(id)?.slug || currentSlug;
    // Submissions seen live via the network hook are fresh. Ones detected only from the DOM
    // (e.g. opening an old submission page) only auto-sync if they were made in the last few minutes.
    const live = viaDom ? timestamp != null && Date.now() / 1000 - timestamp < LIVE_WINDOW_SEC : true;

    let problem = null;
    try {
      problem = await fetchProblem(slug);
    } catch (e) {
      problem = { titleSlug: slug, error: e.message };
    }

    send({
      type: 'ACCEPTED',
      submission: { id, slug, lang, code, timestamp, live },
      problem,
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== INTERCEPTOR) return;

    if (data.kind === 'submit') {
      capturedSubmits.set(String(data.submissionId), { slug: data.slug, lang: data.lang, code: data.code });
      send({ type: 'SUBMISSION_STATUS', submissionId: String(data.submissionId), slug: data.slug, status: 'Judging…', lang: data.lang });
    } else if (data.kind === 'check') {
      const id = String(data.submissionId);
      if (data.statusCode === ACCEPTED || data.statusMsg === 'Accepted') {
        processAccepted(id, { viaDom: false });
      } else if (!handled.has(id)) {
        send({
          type: 'SUBMISSION_STATUS',
          submissionId: id,
          slug: capturedSubmits.get(id)?.slug || currentSlug,
          status: data.statusMsg || 'Finished',
          lang: data.lang,
        });
      }
    }
  });

  // Fallback if LeetCode changes its network API: the result panel on /problems/<slug>/submissions/<id>/.
  function checkDomForAccepted() {
    const m = location.pathname.match(/^\/problems\/[^/]+\/submissions\/(\d+)/);
    if (!m || handled.has(m[1])) return;
    const el = document.querySelector('[data-e2e-locator="submission-result"]');
    if (el && el.textContent.trim().toLowerCase() === 'accepted') processAccepted(m[1], { viaDom: true });
  }

  function tick() {
    if (!alive) return;
    if (location.href !== lastHref) {
      lastHref = location.href;
      const slug = slugFromPath(location.pathname);
      if (slug !== currentSlug) {
        currentSlug = slug;
        announceProblem(slug);
      }
    }
    checkDomForAccepted();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'REFRESH') {
      announceProblem(currentSlug);
      sendResponse({ ok: true, slug: currentSlug });
    }
    return false;
  });

  tick();
  const timer = setInterval(() => {
    if (!alive) clearInterval(timer);
    else tick();
  }, 1000);
})();
