---
name: the-one-by-one-review-phone-fix-is-parked-on-its-own-branch
description: "HISTORY, nothing is parked: the five one-by-one review fixes once held on codex/place-review-deck-phone (the phone layout, the zoom-close focus return, polyclinic photos side by side on a phone, \"Waiting for you\" on a waiting seated customer, the Not readable tab) all shipped in PR 6102, merged 19 Oct 2026 01:43 Cairo; never cherry-pick them again - main has every one, and that remote branch holds stale copies."
metadata:
  node_type: memory
  type: project
  originSessionId: 9c89c8e2-707a-4c93-b3a5-c2e5af87cfa2
  modified: 2026-10-18T22:43:45.668Z
---

The one-by-one review (Place checks, "Review one by one") shipped in PR 6090 and was live at 00:11 Cairo on
19 Oct 2026 (revision 6b45ce6f0). Four fixes came out of browser looks afterwards; desktop layout is fine.

1. **Phone layout — 448ae8589.** At 375 x 812 the pinned decision box (about 330 px on a held place) covered
   426 of the 603 px under the photo and started Back / Next below the screen. Fix: on a phone only Back /
   Next is pinned and the decision follows the facts; on a wide screen the decision stays pinned under the
   facts, as on the Screening review.
2. **Zoom close lost focus — 1c49683fa.** `src/components/ui/use-dialog-a11y.ts` returned focus only when
   `open` turned false, but the zoomed photo (`zoomable-photo.tsx`) is rendered as `{open && ...}` and only
   ever unmounts, so focus fell to the page body and a Tab left the review. The return now runs in the open
   effect's cleanup, onto an element still on the page. This is the SHARED hook, so it fixes every zoomed
   photo app-wide. Browser-proven 2026-10-19 00:45 Cairo: after Escape on the zoom, focus is back on the
   photo inside the review, "1 of 35" unchanged, Tab and Shift+Tab stay inside.
3. **Polyclinic photos side by side on a phone — 35d7782cb** (owner, 2026-10-19 ~01:00 Cairo, choosing
   "side by side"). Stacked, the sign and the timetable each had about 104 x 139 px at 375 x 812; side by
   side, each upright 720 x 1280 photo shows at about 178 x 316, and the label stops 5.5rem short of the
   turn arrows so it wraps instead of running under them. Desktop unchanged (two 480 px photos).
4. **A waiting seated customer reads "Waiting for you" — 8ab14cadf** (owner, 2026-10-19 ~01:05 Cairo).
   `shared-place-customers.tsx` drew "Still being checked" for every viewer while the building's own pill
   said "Waiting for you" to him; now `mode === "team" ? "Still being checked" : "Waiting for you"`, on his
   board and in the review alike. Checked in the compiled Place checks page bundle (the dev page itself
   stuck on a webpack chunk clash while another session's browser compiled the outstation page on the
   same port, with free RAM at 1.8 GB).

5. **A "Not readable" tab in the review — 8235a315c** (owner, 2026-10-19 ~01:20 Cairo: "in the review one by one put
   the unreadable in a separate tab"; he chose "every unreadable one" and "move them out"). Held places,
   places in use and polyclinics whose sign or timetable could not be read are MOVED out of Waiting and
   Not confirmed into their own tab; All keeps each once. The sign rule is ONE function,
   `signCouldNotBeRead` in `place-check-scorecard.ts`, which the scorecard's Not readable column also
   uses, so the two cannot count differently; the predicates live in `slides.ts`.

`tests/place-review-deck.test.ts` pins 1-3 and 5, `tests/phoenix-crm-place-notes.test.ts` pins 4; each
assertion was seen to fire when broken.

**Why:** he refuses a small PR on its own (each merge is ~28 CI minutes), so he chose "hold it for the next
change" when asked.

**UPDATE 2026-10-19 ~01:40 Cairo:** once the Not readable tab made it a real feature, he chose "Open one
PR now" — all five are PR 6102, MERGED 01:43 Cairo 19 Oct 2026 (a04475f58) on his "merge 6102 when green".
Nothing is parked any more; this note is history.

**How to apply (superseded by PR 6102):** the next session that opens a Place checks or field-CRM PR cherry-picks 448ae8589,
1c49683fa, 35d7782cb, 8ab14cadf and 8235a315c onto its own branch and names them in that PR's body, then deletes
`codex/place-review-deck-phone` once merged. Never put them to him as a PR of their own. Related:
[[the-evidence-photo-is-the-primary-source-of-trust]].
