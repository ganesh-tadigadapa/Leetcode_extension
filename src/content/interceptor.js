// Runs in the page's MAIN world at document_start (see manifest.json).
// Observes LeetCode's own submit/check network calls and forwards the results to the
// isolated content script via window.postMessage. It never modifies requests or responses.
(() => {
  if (window.__dsa007LeetCodeSyncHooked) return;
  Object.defineProperty(window, '__dsa007LeetCodeSyncHooked', { value: true });

  const SOURCE = 'dsa007-interceptor';
  const SUBMIT_RE = /^\/problems\/([^/]+)\/submit\/?$/;
  const CHECK_RE = /^\/submissions\/detail\/(\d+)\/check\/?$/;

  function pathOf(url) {
    try {
      return new URL(url, location.href).pathname;
    } catch {
      return '';
    }
  }

  function isInteresting(url) {
    const p = pathOf(url);
    return SUBMIT_RE.test(p) || CHECK_RE.test(p);
  }

  function post(message) {
    window.postMessage({ source: SOURCE, ...message }, location.origin);
  }

  function parse(text) {
    if (!text || typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function handle(url, requestBody, responseText) {
    const path = pathOf(url);

    const submit = path.match(SUBMIT_RE);
    if (submit) {
      const res = parse(responseText);
      const req = parse(typeof requestBody === 'string' ? requestBody : null) || {};
      if (res && res.submission_id != null) {
        post({
          kind: 'submit',
          slug: submit[1],
          submissionId: String(res.submission_id),
          lang: req.lang || null,
          code: typeof req.typed_code === 'string' ? req.typed_code : null,
        });
      }
      return;
    }

    const check = path.match(CHECK_RE);
    if (check) {
      const res = parse(responseText);
      if (res && res.state === 'SUCCESS') {
        post({
          kind: 'check',
          submissionId: check[1],
          statusCode: res.status_code ?? null,
          statusMsg: res.status_msg || null,
          lang: res.lang || null,
        });
      }
    }
  }

  // ---- fetch ----
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
      } catch {
        url = '';
      }
      const watch = url && isInteresting(url);
      let bodyPromise = Promise.resolve(null);
      if (watch) {
        try {
          if (init && typeof init.body === 'string') bodyPromise = Promise.resolve(init.body);
          else if (input instanceof Request) bodyPromise = input.clone().text().catch(() => null);
        } catch {
          // ignore
        }
      }
      const result = originalFetch.apply(this, arguments);
      if (watch) {
        result
          .then((response) => Promise.all([bodyPromise, response.clone().text()]))
          .then(([body, text]) => handle(url, body, text))
          .catch(() => {});
      }
      return result;
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  XHR.open = function (method, url) {
    try {
      this.__dsa007Url = String(url);
    } catch {
      this.__dsa007Url = '';
    }
    return originalOpen.apply(this, arguments);
  };
  XHR.send = function (body) {
    const url = this.__dsa007Url;
    if (url && isInteresting(url)) {
      this.addEventListener('load', () => {
        try {
          let text = null;
          if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
          else if (this.responseType === 'json') text = JSON.stringify(this.response);
          handle(url, typeof body === 'string' ? body : null, text);
        } catch {
          // ignore
        }
      });
    }
    return originalSend.apply(this, arguments);
  };
})();
