---
name: a-refusal-that-saved-nothing-is-only-in-the-touch-trail
description: "RETIRED 2026-11-01 — the trail is gone; a refusal that saved nothing is found on the refused-readings board (/admin/phoenix-crm/refused-readings). History: \"a rep is blocked and the system will not let her through\" was answered from phoenix_crm_touch_trail, because a refusal that wrote nothing leaves no row anywhere else — the refusal MESSAGE itself appears as a press's element_label, which names the exact gate"
metadata:
  node_type: memory
  type: project
  originSessionId: d96338c4-b2ab-41ed-aa4e-ed85e9af64ce
  modified: 2026-11-01T18:57:13.503Z
---

**RETIRED, 1 November 2026** (owner: "retire and delete all its traces"). `phoenix_crm_touch_trail`, its
collector, reader page, route and nightly archive are gone (branch `codex/retire-touch-trail`; the table is
dropped by `20261101203000_retire_phoenix_crm_touch_trail.sql`). A refusal that saved nothing is found on the
refused-readings board now — `/admin/phoenix-crm/refused-readings`, fed since 13 October by the
browser-blocked permission route — not in any trail. Everything below is the method as it stood on
5 October and is kept as history.

Measured 2026-10-05, diagnosing Aya Ibrahim (B-7) blocked on validating مستوصف صدر باجور.

**Three tables answered "nothing happened" and all three were right and useless.**
`phoenix_crm_validation_reviews` had no row for her (a `mismatch` saves nothing, so no hold is
created). `phoenix_crm_refused_readings` had none either — until this day it recorded only a refusal
about the POSITION'S QUALITY (`no_fix` / `rough`), never one about the account. And no customer,
place or list_request row was written by her attempts at all. So every "is she blocked?" query
returns empty for exactly the same reason she is blocked.

**`phoenix_crm_touch_trail` is the one place that holds it**, because it records what she touched
whether or not anything saved. Two things make it decisive:

1. **The refusal message is in `element_label`.** A press with no interactive owner is recorded
   against the container under the finger, whose first line is the error box — so the row literally
   read `This location is not at مستوصف صدر باجور on Goog…`, which names the gate (here
   `googleMismatchMessage`, i.e. the Google listing check) with no guessing.
2. **It shows the workaround and the give-up**, which is what sizes the cost: she tried
   `Add new customer` at 11:15 (refused by the same gate, nothing written), then logged the call as
   an unplanned out-of-list visit at 11:23 — work that scores in nothing.

So read it FIRST, filtered `actor_hr_id` + a time window, `kind in ('press','tap','change','screen')`,
and keyset-paged on the `bigint id` ([[the-trail-is-read-at-admin-field-crm-touch-trail]] — PostgREST
stops at 1,000 rows with no marker and a field day is 1,000–3,000 events per rep).

**Do not try to reproduce the verdict by calling Google from the laptop.** `places:searchText` with
`GOOGLE_MAPS_SERVER_KEY` answered HTTP 200 with `{}` for every query here, including a positive
control that certainly exists (Shibin El Kom Teaching Hospital) — the key geocodes fine, so the
Places (New) probe is simply dead from this machine and its empty answer is an ABSENT result wearing
the shape of a NEGATIVE one. The app's own run is the authority; the refusal text in the trail is
what proves which verdict it reached.

Also: a customer can exist TWICE with the same name on one seat and NOT be a duplicate — one row
carries `is_test = true`. Filter `is_test` before calling anything a duplicate.
