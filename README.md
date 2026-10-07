# DSA_007 LeetCode Sync

Chrome (Manifest V3) extension that commits your **Accepted** LeetCode solutions to
[`ganesh-tadigadapa/DSA_007`](https://github.com/ganesh-tadigadapa/DSA_007) under `LeetCode/<Category>/`:

```
LeetCode/Arrays/283_Move_Zeroes.cpp      commit: "Add LeetCode: 283 Move Zeroes"
```

There's no backend and there are no runtime dependencies. The extension calls the GitHub REST API directly with a fine-grained token that can only access the DSA_007 repository.

## Install

```bash
npm run build        # generates icons, validates manifest, runs tests, writes dist/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this project folder (or `dist/`).
3. The Settings page opens. Create a token:
   - Go to https://github.com/settings/personal-access-tokens/new.
   - Under **Repository access**, choose *Only select repositories* and pick `ganesh-tadigadapa/DSA_007`.
   - Under **Repository permissions**, set **Contents** to *Read and write*. Leave everything else as *No access*.
4. Paste the token and click **Save & test connection**.
5. Reload any LeetCode tabs that were already open.

## How it works

| Piece | Role |
|---|---|
| `src/content/interceptor.js` | Runs in the page (MAIN world). Watches LeetCode's own `/problems/<slug>/submit/` and `/submissions/detail/<id>/check/` calls and only observes them. |
| `src/content/content.js` | Tracks the current problem through the LeetCode GraphQL `question` query (number, title, tags). On Accepted, it loads the code and language from GraphQL `submissionDetails`. LeetCode's server is the source of truth, so a page script can't fake an upload. It also has a fallback: if LeetCode's network API changes, it reads the "Accepted" result panel in the page. |
| `src/background.js` | Holds per-tab state, runs auto-sync, checks for duplicates and commits through the GitHub Contents API. |
| `src/lib/format.js` | Maps tags to folders, builds filenames, maps languages to extensions (C++ `.cpp`, Python `.py`, Java `.java`, JavaScript `.js`, TypeScript `.ts`). |
| `src/popup/` | Shows GitHub status, the auto-sync toggle, the current problem, the submission status, the target path (folder is editable before a manual upload) and the Upload button. |

### Duplicates are never overwritten
Before each upload the extension lists the repo tree. If any file under `LeetCode/` already has the same
problem number and extension, even in a different folder, the upload stops and shows a ⚠ duplicate warning with a link.
The create call never sends a `sha`, so GitHub itself also refuses to replace an existing file.

### Category rules
The first matching specific technique wins. The order is Linked_List, Trie, Segment_Tree, Trees, Graphs, Dynamic_Programming,
Backtracking, Sliding_Window, Binary_Search, Heap, Stack, Queue, Bit_Manipulation and so on. If none match, the first broad tag is used: Arrays, Strings,
Hash_Table, Two_Pointers, Math, Sorting, Greedy, Matrix and so on. For example, Move Zeroes has the tags Array and Two Pointers, so it goes to `Arrays`. Before a
manual upload you can change the folder in the popup. Edit the rules in `src/lib/format.js`.

## Development

```bash
npm test             # unit + simulated worker/content-script tests (node:test)
npm run validate     # manifest + file references + JS syntax
```
After editing, click the reload icon on the extension card in `chrome://extensions` and refresh LeetCode tabs.
