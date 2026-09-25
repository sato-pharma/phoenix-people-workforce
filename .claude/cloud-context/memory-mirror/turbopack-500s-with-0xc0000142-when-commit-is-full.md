---
name: turbopack-500s-with-0xc0000142-when-commit-is-full
description: "A saturated machine makes EVERY dev-server page 500 with a TurbopackInternalError that reads like a CSS/code bug — the real cause is Windows commit exhaustion refusing to spawn the PostCSS worker (exit code 0xc0000142). Read the commit charge, not the error."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 391647f9-8f7a-4e5f-a51e-3371c51627f0
  modified: 2026-08-21T08:53:14.472Z
---

**The symptom lies.** With the machine saturated, every page on `next dev` returns **HTTP 500** with
a `TurbopackInternalError` whose visible head is:

```
Failed to write app endpoint /(admin)/admin/doctor-coverage/page
- [project]/app/globals.css [app-client] (css)
- Execution of parse_css failed
- Execution of <PostCssTransformedAsset as Asset>::content failed
- Execution of evaluate_webpack_loader failed
- creating new process
- node process exited before we could connect to it with exit code: 0xc0000142
```

Every line above the last two points at **CSS**, so the natural reading is "someone broke
`globals.css`" or "a PostCSS plugin is missing". It is neither. `0xc0000142` is Windows
`STATUS_DLL_INIT_FAILED` — the OS **refused to create the process at all**. Turbopack spawns a
separate Node worker to run PostCSS, and that spawn is what failed. Because `app/globals.css` is
imported by the root layout, *every* route fails identically, which makes it look systemic and
code-shaped.

**Read the commit charge before touching any code.** Physical free RAM is not the number that
matters — commit is:

```bash
powershell -NoProfile -Command "$os=Get-CimInstance Win32_OperatingSystem; 'commit used: {0:N2} GB of {1:N2} GB' -f ((\$os.TotalVirtualMemorySize-\$os.FreeVirtualMemory)/1MB), (\$os.TotalVirtualMemorySize/1MB)"
```

Measured 2026-08-21 during a failed 375px verification: **30.55 GB used of a 31.76 GB limit** with
0.69 GB physical free, 34 `claude` processes holding 5.1 GB, plus msedge 1.8 GB, node 1.2 GB,
msedgewebview2 0.9 GB, chrome 0.8 GB. The dev server itself was already up and healthy —
`/api/healthz` returned **200**, and `/api/dev-auth` set its cookie fine — because **API routes need
no CSS worker**. Only rendered pages died. A healthy `healthz` is therefore no evidence the dev
server can serve a page.

**Nothing but terminating processes fixes it.** Commit = physical + pagefile, so trimming working
sets, `EmptyWorkingSet`, or waiting do not lower it. Retrying the request does not help either
(tried 3×, all 500). Restarting the dev server makes it *worse* — a cold start needs more commit
than the warm one already holds.

**Do not go hunting for a safe process to reclaim.** On this machine every `node.exe` above ~30 MB
turned out to be a live MCP server (`@supabase/mcp-server-*`, `openai-bridge/server.mjs`) belonging
to a running session — killing one silently breaks that session's tools. The only real lever is
closing Claude sessions, and that is the owner's call
([[laptop-m17r2-ram-soldered-16gb-ceiling]], [[dont-skip-validation-for-ram-wait-instead]]).

Related: [[verify-a-mobile-layout-without-a-dev-server]] is the fallback when this happens —
it needs ~40 MB instead of ~2 GB and still found a real overflow bug.
[[dev-auth-is-header-only-browser-pane-cannot-use-it]] holds the working browser-login route
(`GET /api/dev-auth?role=…&next=…`), which authenticates fine even while pages 500.
