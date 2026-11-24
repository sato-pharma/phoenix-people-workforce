---
name: prove-a-component-on-a-transpiled-test-page-when-no-dev-server-fits
description: "When the laptop cannot hold a dev server and the spare is unreachable, a client component's real behaviour can still be driven in a browser: transpile the file as it stands with the repo's own TypeScript, stub its imports, and open it on a tiny localhost page in the built-in browser."
metadata:
  node_type: memory
  type: feedback
  originSessionId: fec79187-477a-4fee-951b-cd4da7bc020f
  modified: 2026-11-23T12:01:47.618Z
---

Used on 23 Nov 2026 for pull request 707 (the Place checks "Pick rows" line moved into the section's title row
with `createPortal` and a context). No esbuild, jsdom or happy-dom is installed, a local typecheck is denied,
free memory was under 3 GB and the spare laptop did not answer.

**What worked (about 15 minutes, a few MB of memory):**
- `createRequire(<worktree>/package.json)("typescript")`, then `ts.transpileModule(source, { module: CommonJS,
  jsx: React })` on each changed `.tsx` exactly as it stands.
- One HTML page: React 18.3.1 and ReactDOM UMD from cdnjs, Tailwind from `cdn.tailwindcss.com/3.4.17`, a
  `require` stub map for every import (`next/navigation`, `@/lib/utils`, the neighbouring components as
  plain buttons), each transpiled file loaded with `new Function("exports", "require", "React", code)`.
- Serve it with a one-line `node -e` http server on 127.0.0.1 (the built-in browser shows a `file://` page as
  a static snapshot and runs no script), open it with `mcp__Claude_Browser__navigate`, drive it with
  `javascript_tool`, then stop the server by its port. Other widths: an `<iframe>` of that width on the same
  page (`resize_window` did not change `innerWidth` there).

**Why:** source-pin tests cannot prove a portal, a context or focus; this did (line in the slot, no box idle,
the box on a tick, focus kept on Pick all, the box again after a run).

**How to apply:** say plainly in the pull request that the buttons and rows are stand-ins and React is 18, so
the page's pixels are not the app's; take pixel figures from the live page's own elements instead
([[his-screen-is-2390-css-px-wide-measure-there]]). It never replaces opening the branch in the real app when
a server can run. This is my own reading of what was useful, not an instruction from the owner.
