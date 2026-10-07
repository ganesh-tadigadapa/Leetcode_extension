// Minimal GitHub REST client (https://docs.github.com/en/rest) used by the service worker.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.data = data;
  }
}

function friendlyError(status, data, headers) {
  const apiMessage = (data && typeof data === 'object' && data.message) || '';
  if (status === 401) return 'GitHub rejected the token (expired or revoked). Create a new one in Settings.';
  if (status === 403 && headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
    return `GitHub API rate limit reached. Try again after ${new Date(reset).toLocaleTimeString()}.`;
  }
  if (status === 403) {
    return `GitHub denied access: ${apiMessage || 'forbidden'}. The token needs "Contents: Read and write" on the repository.`;
  }
  if (status === 404) return 'Repository not found, or the token has no access to it.';
  return apiMessage ? `GitHub API error ${status}: ${apiMessage}` : `GitHub API error ${status}`;
}

async function request(token, method, path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new GitHubError(`Network error talking to GitHub: ${e.message}`, 0, null);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) throw new GitHubError(friendlyError(res.status, data, res.headers), res.status, data);
  return data;
}

const enc = (s) => encodeURIComponent(s);
const encPath = (p) => p.split('/').map(enc).join('/');

export async function getUser(token) {
  return request(token, 'GET', '/user');
}

export async function getRepo(token, owner, repo) {
  return request(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}`);
}

export async function verifyConnection(token, owner, repo) {
  const [user, repoInfo] = await Promise.all([getUser(token), getRepo(token, owner, repo)]);
  return {
    login: user.login,
    fullName: repoInfo.full_name,
    defaultBranch: repoInfo.default_branch,
    private: repoInfo.private,
    canPush: repoInfo.permissions ? Boolean(repoInfo.permissions.push) : null,
    htmlUrl: repoInfo.html_url,
  };
}

async function getContent(token, owner, repo, branch, path) {
  try {
    return await request(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}/contents/${encPath(path)}?ref=${enc(branch)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Finds an already-committed solution for the same problem number + language anywhere under
// basePath (even in a different category folder or with a slightly different title).
// Returns { path, htmlUrl } or null.
export async function findExistingSolution(token, owner, repo, branch, { basePath, number, ext, path }) {
  const blobUrl = (p) => `https://github.com/${owner}/${repo}/blob/${encPath(branch)}/${encPath(p)}`;

  let tree;
  try {
    tree = await request(token, 'GET', `/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(branch)}?recursive=1`);
  } catch (e) {
    // 409: empty repository (no commits yet). 404: branch has no tree yet.
    if (e.status === 409 || e.status === 404) return null;
    throw e;
  }

  const prefix = basePath ? `${basePath.toLowerCase()}/` : '';
  const numberPrefix = `${number.toLowerCase()}_`;
  const suffix = `.${ext.toLowerCase()}`;
  const match = (tree.tree || []).find((entry) => {
    if (entry.type !== 'blob') return false;
    const p = entry.path.toLowerCase();
    if (!p.startsWith(prefix)) return false;
    const base = p.slice(p.lastIndexOf('/') + 1);
    return base.startsWith(numberPrefix) && base.endsWith(suffix);
  });
  if (match) return { path: match.path, htmlUrl: blobUrl(match.path) };

  if (tree.truncated) {
    // Very large repo: the recursive listing is incomplete, fall back to an exact-path check.
    const existing = await getContent(token, owner, repo, branch, path);
    if (existing) return { path, htmlUrl: existing.html_url || blobUrl(path) };
  }
  return null;
}

// Creates a NEW file. No `sha` is sent, so GitHub refuses (422) if the file already exists:
// an existing solution can never be overwritten by this call.
export async function createFile(token, owner, repo, branch, { path, contentBase64, message }) {
  try {
    const data = await request(token, 'PUT', `/repos/${enc(owner)}/${enc(repo)}/contents/${encPath(path)}`, {
      message,
      content: contentBase64,
      branch,
    });
    return {
      path: data.content.path,
      htmlUrl: data.content.html_url,
      commitUrl: data.commit.html_url,
      commitSha: data.commit.sha,
    };
  } catch (e) {
    if (e.status === 422 && /sha/i.test(JSON.stringify(e.data || ''))) {
      const dup = new GitHubError('A file already exists at this path.', 422, e.data);
      dup.duplicate = true;
      throw dup;
    }
    throw e;
  }
}
