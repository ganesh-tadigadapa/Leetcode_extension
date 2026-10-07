import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorize,
  buildFilename,
  getLanguage,
  planUpload,
  toBase64Utf8,
  commitMessage,
  sanitizeFolder,
  ensureTrailingNewline,
} from '../src/lib/format.js';

const t = (...names) => names.map((name) => ({ name, slug: name.toLowerCase().replace(/ /g, '-') }));

test('categorize: user example (Move Zeroes) goes to Arrays', () => {
  assert.equal(categorize(t('Array', 'Two Pointers')), 'Arrays');
});

test('categorize: specific techniques beat broad tags', () => {
  assert.equal(categorize(t('Array', 'Binary Search')), 'Binary_Search');
  assert.equal(categorize(t('Linked List', 'Two Pointers')), 'Linked_List');
  assert.equal(categorize(t('Tree', 'Depth-First Search', 'Binary Tree')), 'Trees');
  assert.equal(categorize(t('Array', 'Depth-First Search', 'Breadth-First Search', 'Union Find', 'Matrix')), 'Graphs');
  assert.equal(categorize(t('Array', 'Binary Search', 'Dynamic Programming')), 'Dynamic_Programming');
  assert.equal(categorize(t('String', 'Stack')), 'Stack');
  assert.equal(categorize(t('Array', 'Queue', 'Sliding Window', 'Heap (Priority Queue)', 'Monotonic Queue')), 'Sliding_Window');
});

test('categorize: broad tags and fallbacks', () => {
  assert.equal(categorize(t('String')), 'Strings');
  assert.equal(categorize(t('Hash Table', 'String', 'Sorting')), 'Hash_Table');
  assert.equal(categorize(t('Math')), 'Math');
  assert.equal(categorize(t('Brainteaser', 'Math')), 'Math');
  assert.equal(categorize(t('Game Theory')), 'Game_Theory');
  assert.equal(categorize([]), 'Misc');
  assert.equal(categorize(undefined), 'Misc');
});

test('filename format <number>_<title>.<ext>', () => {
  assert.equal(buildFilename('283', 'Move Zeroes', 'cpp'), '283_Move_Zeroes.cpp');
  assert.equal(buildFilename('50', 'Pow(x, n)', 'py'), '50_Pow_x_n.py');
  assert.equal(buildFilename('167', 'Two Sum II - Input Array Is Sorted', 'java'), '167_Two_Sum_II_Input_Array_Is_Sorted.java');
  assert.equal(buildFilename('LCR 001', 'Café Problem', 'ts'), 'LCR_001_Cafe_Problem.ts');
});

test('languages: the five supported ones map to extensions', () => {
  assert.equal(getLanguage('cpp').ext, 'cpp');
  assert.equal(getLanguage('C++').ext, 'cpp');
  assert.equal(getLanguage('python').ext, 'py');
  assert.equal(getLanguage('python3').ext, 'py');
  assert.equal(getLanguage('java').ext, 'java');
  assert.equal(getLanguage('javascript').ext, 'js');
  assert.equal(getLanguage('typescript').ext, 'ts');
  assert.equal(getLanguage('golang'), null);
  assert.equal(getLanguage(null), null);
});

test('planUpload builds the exact path and commit message', () => {
  const plan = planUpload({
    problem: { questionFrontendId: '283', title: 'Move Zeroes', topicTags: t('Array', 'Two Pointers') },
    submission: { lang: 'cpp' },
    settings: { basePath: 'LeetCode' },
  });
  assert.equal(plan.path, 'LeetCode/Arrays/283_Move_Zeroes.cpp');
  assert.equal(plan.message, 'Add LeetCode: 283 Move Zeroes');
  assert.equal(commitMessage('283', 'Move Zeroes'), 'Add LeetCode: 283 Move Zeroes');
});

test('planUpload honours a manual category and rejects unsupported languages', () => {
  const problem = { questionFrontendId: '1', title: 'Two Sum', topicTags: t('Array', 'Hash Table') };
  const plan = planUpload({ problem, submission: { lang: 'java' }, settings: {}, categoryOverride: 'my folder/../x' });
  assert.equal(plan.path, 'LeetCode/my_folder_x/1_Two_Sum.java');
  assert.throws(() => planUpload({ problem, submission: { lang: 'rust' }, settings: {} }), /Unsupported language/);
  assert.equal(sanitizeFolder('../../etc'), 'etc');
});

test('UTF-8 safe base64', () => {
  const s = '// naïve → ✓ 日本\nint main() {}\n';
  assert.equal(Buffer.from(toBase64Utf8(s), 'base64').toString('utf8'), s);
  const big = 'x'.repeat(200000);
  assert.equal(Buffer.from(toBase64Utf8(big), 'base64').toString('utf8'), big);
  assert.equal(ensureTrailingNewline('a'), 'a\n');
  assert.equal(ensureTrailingNewline('a\n'), 'a\n');
});
