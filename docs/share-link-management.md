# Share-link management screens

The three live Google Sheets (CV Lifecycle, Direct Orders, Marketing Requests) each read Phoenix through a bearer token in an unauthenticated route. This is the account behind the rules in `.claude/rules/platform.md`, "Live-sheet share links".

## The list never carries the whole token

Direct Orders and Marketing mapped `token: String(row.token)` into the row their `GET .../report/share-links` serialised until 13 Oct 2026, so every live bearer credential reached the browser of anyone holding export: devtools, the React tree, any error report that captured a network body. Hiding it in JSX would have left all of that untouched. The CV-lifecycle service was fixed first and is the shape the other two now follow.

- The row type has no `token` field; it carries `tokenPreview`, the first 8 characters, which is also what the audit rows store.
- The whole token leaves only in the mint response (`created.token` on the screen). A lost token is revoked and a new link minted.
- Pinned by `tests/share-link-lists-omit-token.test.ts` and section 3 of `tests/cv-lifecycle-share-links-screen.test.ts`.

## The Marketing panel (13 Oct 2026)

Marketing's links were API-only, so nothing on any screen could say that a second live feed link had paused the weekly token rotation. `src/components/marketing-requests/report-share-links-panel.tsx` is mounted on both All Marketing Requests registers and carries the shared `LiveFeedAmbiguityBanner`.

- Gated on `expenses:export`, exactly as `src/lib/marketing-requests/report-share-links.ts` asserts on list, create and revoke.
- Sheets feed only. No route serves a Marketing `live` link (only `/api/share/marketing-requests/[token]/feed` and `/file` exist), so offering one would hand out a URL that opens nothing.
- The sheet's Apps Script (`docs/marketing-request-live-sheet.gs`) reads a `FEED_TOKEN` script property and builds the address itself, so the mint result shows the bare token once, with the `refreshMarketingRequests` step.
- `SHARE_LINK_FEEDS` (`src/lib/share-links/feeds.ts`) names the screen, so the dead-token alert's button opens it.
- Pinned by `tests/marketing-share-links-panel.test.ts` and `tests/live-feed-rotation-paused.test.ts`.

A new live sheet ships its banner in the same PR that adds its feed.
