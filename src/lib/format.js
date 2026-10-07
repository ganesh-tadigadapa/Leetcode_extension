// Pure helpers shared by the service worker, popup and unit tests.
// No chrome.* APIs in here so it can run under plain Node.

export const DEFAULT_SETTINGS = Object.freeze({
  owner: 'ganesh-tadigadapa',
  repo: 'DSA_007',
  basePath: 'LeetCode',
  autoSync: true,
});

// LeetCode language slugs (as returned by the submit/check APIs and GraphQL `lang.name`).
const LANGUAGES = {
  cpp: { ext: 'cpp', label: 'C++' },
  python: { ext: 'py', label: 'Python' },
  python3: { ext: 'py', label: 'Python3' },
  java: { ext: 'java', label: 'Java' },
  javascript: { ext: 'js', label: 'JavaScript' },
  typescript: { ext: 'ts', label: 'TypeScript' },
};

const LANGUAGE_ALIASES = {
  'c++': 'cpp',
  'python 3': 'python3',
  js: 'javascript',
  ts: 'typescript',
};

export const SUPPORTED_LANGUAGE_LABELS = ['C++', 'Python', 'Java', 'JavaScript', 'TypeScript'];

export function getLanguage(lang) {
  if (!lang) return null;
  let key = String(lang).trim().toLowerCase();
  key = LANGUAGE_ALIASES[key] || key;
  const info = LANGUAGES[key];
  return info ? { slug: key, ...info } : null;
}

// Ordered: the first group that matches any of the problem's tags wins.
// Structural / technique tags that define how a problem is solved come first;
// broad tags like Array/String are only used when nothing more specific applies.
const PRIORITY_CATEGORIES = [
  ['Linked_List', ['linked-list', 'doubly-linked-list']],
  ['Trie', ['trie']],
  ['Segment_Tree', ['segment-tree', 'binary-indexed-tree']],
  ['Trees', ['tree', 'binary-tree', 'binary-search-tree']],
  ['Graphs', [
    'graph', 'topological-sort', 'shortest-path', 'minimum-spanning-tree', 'union-find',
    'eulerian-circuit', 'strongly-connected-component', 'biconnected-component',
    'depth-first-search', 'breadth-first-search',
  ]],
  ['Dynamic_Programming', ['dynamic-programming', 'memoization']],
  ['Backtracking', ['backtracking']],
  ['Sliding_Window', ['sliding-window']],
  ['Binary_Search', ['binary-search']],
  ['Heap', ['heap-priority-queue']],
  ['Stack', ['stack', 'monotonic-stack']],
  ['Queue', ['queue', 'monotonic-queue']],
  ['Bit_Manipulation', ['bit-manipulation', 'bitmask']],
  ['Database', ['database']],
  ['Shell', ['shell']],
  ['Concurrency', ['concurrency']],
];

const GENERAL_CATEGORIES = {
  array: 'Arrays',
  string: 'Strings',
  'string-matching': 'Strings',
  'rolling-hash': 'Strings',
  'hash-table': 'Hash_Table',
  'hash-function': 'Hash_Table',
  counting: 'Hash_Table',
  'two-pointers': 'Two_Pointers',
  math: 'Math',
  'number-theory': 'Math',
  combinatorics: 'Math',
  geometry: 'Math',
  'probability-and-statistics': 'Math',
  sorting: 'Sorting',
  'counting-sort': 'Sorting',
  'bucket-sort': 'Sorting',
  'radix-sort': 'Sorting',
  'merge-sort': 'Sorting',
  quickselect: 'Sorting',
  greedy: 'Greedy',
  matrix: 'Matrix',
  'prefix-sum': 'Prefix_Sum',
  simulation: 'Simulation',
  recursion: 'Recursion',
  'divide-and-conquer': 'Divide_and_Conquer',
  design: 'Design',
  iterator: 'Design',
  'data-stream': 'Design',
  'ordered-set': 'Design',
};

export const CATEGORY_SUGGESTIONS = [
  ...new Set([...PRIORITY_CATEGORIES.map(([name]) => name), ...Object.values(GENERAL_CATEGORIES), 'Misc']),
].sort();

function tagSlug(tag) {
  if (!tag) return '';
  if (typeof tag === 'string') return tag.trim().toLowerCase().replace(/\s+/g, '-');
  return String(tag.slug || tag.name || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function tagName(tag) {
  return typeof tag === 'string' ? tag : tag?.name || tag?.slug || '';
}

export function sanitizeFolder(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
}

// topicTags: [{ name, slug }] as returned by LeetCode GraphQL (order preserved).
export function categorize(topicTags) {
  const tags = Array.isArray(topicTags) ? topicTags.filter(Boolean) : [];
  if (tags.length === 0) return 'Misc';
  const slugs = new Set(tags.map(tagSlug));
  for (const [category, keys] of PRIORITY_CATEGORIES) {
    if (keys.some((k) => slugs.has(k))) return category;
  }
  for (const tag of tags) {
    const category = GENERAL_CATEGORIES[tagSlug(tag)];
    if (category) return category;
  }
  return sanitizeFolder(tagName(tags[0])) || 'Misc';
}

export function sanitizeTitle(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function sanitizeNumber(frontendId) {
  return String(frontendId ?? '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// "283", "Move Zeroes", "cpp" -> "283_Move_Zeroes.cpp"
export function buildFilename(frontendId, title, ext) {
  const number = sanitizeNumber(frontendId);
  const name = sanitizeTitle(title);
  if (!number || !name || !ext) throw new Error('Missing problem number, title or language');
  return `${number}_${name}.${ext}`;
}

export function joinPath(...parts) {
  return parts
    .map((p) => String(p || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

export function commitMessage(frontendId, title) {
  return `Add LeetCode: ${String(frontendId).trim()} ${String(title).trim()}`;
}

export function ensureTrailingNewline(code) {
  const s = String(code ?? '');
  return s.endsWith('\n') ? s : `${s}\n`;
}

// UTF-8 safe base64 (btoa alone breaks on non-Latin1 characters in comments etc.).
export function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Everything the uploader needs, derived from a LeetCode problem + accepted submission.
export function planUpload({ problem, submission, settings, categoryOverride }) {
  if (!problem || !problem.questionFrontendId || !problem.title) {
    throw new Error('Problem details are not loaded yet');
  }
  const lang = getLanguage(submission?.lang);
  if (!lang) {
    throw new Error(
      `Unsupported language "${submission?.lang || 'unknown'}". Supported: ${SUPPORTED_LANGUAGE_LABELS.join(', ')}`,
    );
  }
  const override = sanitizeFolder(categoryOverride);
  const category = override || categorize(problem.topicTags);
  const filename = buildFilename(problem.questionFrontendId, problem.title, lang.ext);
  const basePath = joinPath(settings?.basePath ?? DEFAULT_SETTINGS.basePath);
  return {
    lang,
    ext: lang.ext,
    category,
    filename,
    basePath,
    number: sanitizeNumber(problem.questionFrontendId),
    path: joinPath(basePath, category, filename),
    message: commitMessage(problem.questionFrontendId, problem.title),
  };
}
