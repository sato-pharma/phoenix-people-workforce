---
name: a-broken-rsc-page-still-returns-http-200
description: "A Next page that dies on the server/client boundary still answers HTTP 200 with megabytes of HTML — the crash rides in the streamed payload as an error digest and is swapped in on the client. Probe for the DIGEST from inside an authenticated page, never for the status code."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 391647f9-8f7a-4e5f-a51e-3371c51627f0
  modified: 2026-08-21T09:47:22.884Z
---

**A status sweep cannot see a broken page.** On 2026-08-21 `/admin/doctor-coverage` and
`/employee-portals/doctor-coverage` showed "Admin workspace unavailable" to every user for
about an hour. Fetched from inside an authenticated session they returned:

```
status 200 · 2,500 KB of HTML · contains "Call list" · does NOT contain "Admin workspace unavailable"
digests: 1878765947, 3180310587, 923360379
```

Next streams the shell, hits the error while rendering, embeds the digest in the stream, and
React swaps the error boundary in **on the client**. So the response is a 200 full of real
content and the failure is only visible as a `digest` in the payload. Checking `curl -o
/dev/null -w %{http_code}` proves nothing — worse, unauthenticated every admin route **307s to
`/login` before the component ever runs**, so an anonymous sweep reports a healthy redirect for
a page that is completely dead. Both of those checks were run that morning and both passed.

**The probe that works** — run in the browser pane's already-authenticated tab, no dev server,
no cookie extraction (the session cookie is httpOnly and unreadable):

```js
const r = await fetch(path, { credentials: "same-origin" });
const t = await r.text();
const digests = [...new Set((t.match(/digest[^0-9]{0,12}(\d{6,})/g) || []).map(s => s.replace(/\D/g, "")))];
// digests.length === 0  ⟺  the page actually rendered
```

Loop it over several routes in one call. **Always include a route you expect to be healthy** as
a control — `/admin/brick-coverage` returned zero digests in the same sweep, which is what
proves the probe is not simply finding digests everywhere.

This works while `document.visibilityState === "hidden"`, which matters: an off-screen Browser
pane never fires `requestAnimationFrame`, so Next's streamed `<div hidden id="S:n">` blocks
never swap in and every layout measurement reads 0
([[verify-a-mobile-layout-without-a-dev-server]]). `fetch` needs no layout at all, so a hidden
pane can still verify that a deployed page renders — it just cannot measure how it looks.

The bug behind this one: [[a-server-component-cannot-pass-a-function-to-a-client-one]].
