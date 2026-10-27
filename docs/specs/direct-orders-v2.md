> **SUPERSEDED (2026-08-11).** The current authoritative spec is [direct-orders.md](./direct-orders.md).
> This file is kept for history — where it disagrees with that file, that file is correct.

# Direct Orders V2 — Agreed Specification

**Date agreed:** 2026-08-04 (evening, after the module's first live day)
**Status:** Stage 1 shipped as [#1738](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1738)
and Stage 2 as [#1748](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1748); both are
merged and live. All six migrations those two PRs carried are applied in production — verified
2026-08-06 against `pg_class`/`pg_proc`, not the migration ledger. **15 of 28 items are closed**;
every remaining box is open, and section H records exactly what each one is still waiting on.
**Rule for every item:** it is DONE only when its checkbox is ticked with a link to the PR + the
test that locks it. Claims without proof do not close an item.

The one law behind everything: **money only moves on the map.** Nothing off the master customer
database ever touches approvals, sales, achievement, or incentives.

---

## A. Master data & trust

- [x] **A1. Single source of truth.** Only distributor sales sheets create trusted customers
      (`source_of_sales_customer_map`). The order form NEVER creates a pharmacy record.
      **Closed — already locked, never credited.** `tests/direct-orders-approval-detail-names.test.ts`
      asserts *"the order form must never mint a confirmed pharmacy"* and *"a hand-registered
      pharmacy must be flagged"*. Trust comes from the distributor sheets; every other route
      produces a pharmacy marked for review. A1 is enforced by A2+A3+B6 together — there is no
      separate thing to build.
- [x] **A2. Pharmacy Validation flow** (modeled on Marketing Customer Validation, familiar to all
      staff): requester initiates from a held order → evidence required — **live camera storefront
      photo, GPS pinned inside the requester's own area** (no gallery uploads) + pharmacy details
      → lands on the **Super Admin validation desk** showing the evidence, the map pin, and the
      closest directory matches → SA either **matches to an existing code** (order rewires),
      **approves as new** (official code, provisional), or **rejects**.
      **Closed by** [#1748](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1748) ·
      `tests/direct-orders-pharmacy-validation.test.ts` — locks live-capture only ("the shutter must
      refuse before a location exists"), the server-computed area verdict ("the browser must never
      supply its own compliance verdict"), and all three SA outcomes incl. "rejecting must NOT
      confirm the pharmacy — the order stays held".
- [x] **A3. Probation (90 days).** An SA-approved pharmacy is *provisional* until a footprint
      confirms it: appears in a distributor sheet OR its collection is paid. Footprint → auto
      promote to trusted. No footprint in 90 days → **automatic phantom report** (pharmacy, order,
      value, **rep's name**) to owner + CEO.
      **Closed by** [#1748](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1748) ·
      `tests/direct-orders-pharmacy-validation.test.ts` — locks "the probation window is 90 days",
      both footprints ("distributor sales count", "a paid collection counts"), and the demotion of a
      provisional pharmacy "so a wrong approval self-corrects". Phantom report:
      `src/lib/direct-orders/phantom-report.ts`, swept by `/api/cron/direct-orders-probation`.
      **Repaired 2026-08-06** in
      [#1829](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1829): the footprint
      lookup queried `source_of_sales_import_rows.customer_code`, a column that does not exist —
      PostgREST answered with an error and no count, the code read `count ?? 0`, and so the
      **promotion half of probation could never fire once.** Two live pharmacies had 23 matching
      rows between them the whole time. Now filtered on `client_code` and the error is thrown,
      locked by `tests/direct-orders-pharmacy-standing.test.ts`.
- [x] **A4. Cleanup of 2026-08-04 data.** The 10 hand-created pharmacies (DOP-000001..10) and
      their 12 requests migrate into the new states. **Open owner decisions:** see section G.

      **Closed 2026-08-05 by owner ruling:** all 12 pharmacies false → `rejected` + inactive,
      14 orders `rejected`, **0 sales injected** (every `sales_month` null, so nothing to unwind).
      The `rejected` state the ruling needed did not exist until #1804 ·
      `tests/direct-orders-pharmacy-rejected.test.ts`.
## B. Submission experience

- [x] **B1. Combo box** over the live union of the customer directory + validated Phoenix
      pharmacies. No cached list — a pharmacy added by any route is findable immediately.
      **Closed — already locked, never credited.** `tests/direct-orders-approval-detail-names.test.ts`:
      *"the customer search must exist"*, *"changing distributor must clear the chosen customer"*,
      *"a stale type-ahead response must not overwrite a newer one"*, *"manual entry must always
      remain available"*.
- [x] **B2. Arabic-safe search**: normalized matching (ta-marbuta/ha, alef forms, ya/alef-maqsura,
      harakat stripped) on BOTH sides + **code search** (prefix, then contains). Unnamed customers
      (6,089) appear as `code — (no name on file)`, never hidden. (SQL migration
      `20260804183000_direct_order_customer_directory_search.sql` shipped in #1738 and **is applied
      in production** — `phx_normalize_arabic` and `phx_search_direct_order_customers` both confirmed
      live 2026-08-06. Box stays open: no test locks this search path. See H.)
      **Closed by** [#1830](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1830) ·
      `tests/direct-orders-arabic-search.test.ts`. The rule lives in SQL, so the test locks the
      migration: one assertion per letter family, and a guard on the harakat strip class —
      widening it to swallow the Arabic LETTERS at 0621..063A emptied the probe, and an empty
      probe `ilike '%%'` matched **all 51,192 rows while looking like a working search**.
- [x] **B3. Area auto-fills from the chosen customer** (by AREA, per owner — not brick) and locks.
      **Closed by** [#1830](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1830) ·
      `tests/direct-orders-area-autofill.test.ts`. The real rule is stronger than "auto-fills":
      the request body carries **pointers only**. If the client could send an area, a rep could
      file any pharmacy in the country under their own geography and every downstream number —
      counters, attribution, the chain built from the requester's line — would agree with them.
- [x] **B4. Did-you-mean (AI v1):** before a "new pharmacy" claim is accepted, show closest
      directory matches; **record shown-and-refused** on the request.
      **Closed by** [#1748](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1748) ·
      `tests/direct-orders-pharmacy-validation.test.ts` — locks "what Phoenix offered must be
      recorded on the claim", "the shown-and-refused record must be computed server-side, not taken
      from the client", and reproducibility ("suggestions use trigram similarity — deterministic, so
      the record reproduces identically later").
- [x] **B5. Invoice-photo prefill (AI v1):** photograph the distributor invoice → extract
      customer code, products, quantities → prefill the form.
      **Closed by** [#1795](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1795) ·
      `tests/direct-orders-invoice-prefill.test.ts` — locks that an unconfirmed customer code
      prefills NOTHING (no nearest-match fallback, asserted), that unmatched lines are named
      rather than dropped, and that it is mounted on BOTH submit forms.
- [x] **B6. Held lane.** Unknown pharmacy → submission allowed → status **HELD**: timestamped,
      enters NO approval chain, appears in NO approver queue, injects NOTHING. Requester sees a
      "Start pharmacy validation" path. **14-day expiry**: untouched held orders auto-expire,
      logged, counted per rep.
      **Closed by** [#1738](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1738) ·
      `tests/direct-orders-held-lane.test.ts` — locks "a held submit must seed NO approval steps —
      the chain is built at revival, not submission", "the clock defaults to 14 days (owner spec
      B6)", "held is NOT terminal — it has three live doors out", "expired is terminal — a dead end,
      not a pause", and "the expiry sweep must be CRON_SECRET-guarded".

## C. Approval workflow

- [x] **C1. Chain shape:** SFE Manager → requester's management line (person rungs) → CEO.
      **Super Admin is not a rung.** SA keeps: see-all, act-on-any-rung override, return-for-edit.
      **Closed by** [#1738](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1738) ·
      `tests/direct-orders-approval-flow.test.ts` + `tests/direct-orders-approval-detail-names.test.ts`
      — lock "the chain is SFE → sales line → CEO, with no acknowledgment rung wedged into it", "no
      chain may push a Super Admin rung — the rung is retired", "SFE must still be pushed onto the
      chain before the management line", and the retained SA-only path ("the standalone
      acknowledgment must stay Super Admin, never widen to the registry roles").
- [x] **C2. GOLDEN RULE — Finance month gate.** CEO approval never injects sales. Injection
      happens ONLY when the Finance Manager (HR_ID B-185, or SA) selects the order's month; null
      month = in no month. (Already live since #1666.) **UI must show the state in words:**
      "approved — awaiting Finance month" badge everywhere the order appears.
      **Closed by** [#1820](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1820) ·
      `tests/direct-orders-finance-month-badge.test.ts` — the badge now appears on all five
      surfaces via one shared pill, and the rule is EXECUTED across all ten status/month
      combinations, including the inverse error (a booked order must not show it).
- [x] **C3. Bulk held-notice button** (System Admin): select multiple held requests → one email
      per request — **To: requester BY NAME (never a code)**, CC: SFE Manager, direct manager,
      CEO — "held until you provide a valid pharmacy code; your pharmacy is not in the master
      database."
      **Closed by** [#1738](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1738) ·
      `tests/direct-orders-held-lane.test.ts` — locks "the notice must address the requester by
      NAME, never by code (owner rule)" and "a request that is no longer held must be SKIPPED —
      never email a stale demand". UI: `src/components/direct-orders/held-desk.tsx`.
- [x] **C4. ONE email, To + CC — never duplicate copies.** Every direct-order notification sends
      a single email: To = the concerned person, CC = the others. No more N copies of the same
      message.
      **Closed by** [#1738](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1738) ·
      `tests/direct-orders-held-lane.test.ts` — locks "the held notice must lead with the requester
      (the email's To) and CC SFE, direct manager, CEO"; the suite is registered in
      `tests/run-tests.ts` under "…one To/Cc email per event".
- [x] **C5. Visibility from creation.** CEO, SFE, Super Admin, and every person in the request's
      chain can open it read-only from the moment it exists, with live step tracking. Action
      buttons appear only on your turn.
      **Closed — already locked, never credited.** `tests/direct-orders-approval-flow.test.ts`:
      *"a per-request scope guard must exist"*, *"an assigned approver must always be able to open
      the request"*, *"company-tier roles keep full read"*, *"subtree tier must reuse the report's
      visible-requester set"*. Verified live 2026-08-06: every request in production carries its
      full chain **0.17s** after creation. Three requests showed a 9–10h gap; all three are held
      requests, which have no chain until release — the design working, not a hole.
- [x] **C6. Deep workflow audit.** TS chain vs DB registry (both directions), every
      status/transition, `expectedNextStatus` couplings, notification fan-out, role gates incl.
      denial paths, held/returned/reversed edges, Finance gate. Deliverable: findings + fixes.

      **Closed by** [#1820](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1820) ·
      `docs/audits/direct-orders-workflow-audit.md` — 7 findings, all fixed (F1 caused a
      production outage). Each fix carries its own test; see the audit for the table.
## D. The approval window (premium)

- [x] **D1. Comprehensive detail on one screen:** requester (name/role/area) · pharmacy (name,
      Phoenix code, all distributor codes, address, map pin, verification/probation state,
      validation evidence photos) · order lines (qty, bonus, discount, pharmacy price, value per
      the LOCKED pricing rule) · full chain history (who, when, wrote what) · collection date +
      payment state · Finance-month badge.
      **Closed — already locked, never credited.** `tests/direct-orders-approval-detail-names.test.ts`:
      *"the pharmacy NAME must reach the approver"*, *"the DISTRIBUTOR must reach the approver"*,
      *"the detail payload must resolve the area's medical rep"*, *"brick and area must be separate
      fields"*, *"an unset price must read as a dash, never as 0 EGP"*.
- [x] **D2. Pharmacy sales history** from SoS shown to approvers (distributors, recent months,
      products, values). Provisional pharmacy → "no history — new pharmacy, probation day X/90"
      in words. An empty table must never read as zero.
      **Closed by** the retail table in
      [#1665](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1665) plus the standing
      prose in [#1829](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1829) ·
      `tests/direct-orders-pharmacy-standing.test.ts` — locks "a null probation clock is not day
      zero — it is no clock at all", "an established pharmacy with no sales must read as not having
      bought, never as unverified", and that the window renders the domain's sentence rather than
      inferring anything from `retailHistory.length`.
      The 2026-08-06 audit recorded D2 as never built; that was **wrong** — it grepped
      `src/components/direct-orders/` and the file is at
      `src/components/approvals-hub/direct-order-request-detail.tsx`. The table was real; what
      #1829 added is the part that was genuinely missing — why it is empty.
- [x] **D3. Premium, polished design** matching the module's design identity. Desktop = full
      tables; mobile = cards. No truncation, no wrapping. Owner emphasis (twice): the manager-
      facing approval experience is the face of the system — it must feel premium, complete, and
      never embarrassing.
      **Closed by TWO PRs, and #1833 alone was not enough** ·
      `tests/direct-orders-approval-window-mobile.test.ts`.

      [#1833](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1833) — the tables.
      Desktop was already right: three full tables, zero truncation, 50 `whitespace-nowrap`.
      **Mobile did not exist** — no `md:hidden` anywhere in the file, so a phone got three tables,
      two of them 820px and 760px wide behind a horizontal scroll. Backwards, too:
      `held-desk`, `pharmacy-registry-manager`, `rep-counters-table` and the employee-portal copy
      of THIS screen all split correctly, so the rep got cards and the approver got the scrolling
      table. The test locks it **per table**, not by counting breakpoint classes file-wide — a
      file-wide count stays green when a fourth table arrives with no wrapper.

      [#1836](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1836) — the field grid,
      which #1833 left alone on the reasoning that it already carried a breakpoint
      (`grid-cols-2 md:grid-cols-4`). That reasoning was wrong. Measured live at 375px: two columns
      give each value 150px while **eight values need up to 287px** — the request id, the
      requester's "name · code · role", a price carrying its "(on file, not used — discount deal)"
      note. Every value is `whitespace-nowrap` by the owner's standing rule, so they did not wrap;
      they **ran into the next column and printed on top of it**. Two columns of overlapping text
      is worse than the horizontal scroll #1833 had just removed. Fixed to
      `grid-cols-1 sm:grid-cols-2 md:grid-cols-4`: one column gives 317px against a widest value of
      287px, so all eight fit.

      **Why this box was ticked once before it was true, which is the part worth keeping.** After
      #1833 every source-level check passed at 375px: three tables provably desktop-only, cards
      rendering, `scrollWidth === clientWidth` so no horizontal page scroll, zero `text-overflow:
      ellipsis`, zero wrapped table cells. All true. All green. The screen was unreadable. Nothing
      in the markup was wrong — a two-column grid is an ordinary thing to write — so **no
      source-text test on this file could have found it.** The collision only exists once real
      values have real widths at a real viewport. That is the honest limit of the source-text
      testing the rest of this module relies on, and D3 is the box where it bites hardest, because
      D3 is the only requirement here that is fundamentally about what a screen LOOKS like.

      **Not yet verified:** the post-#1836 render has not been seen. The defect was measured in a
      browser and the fix is live (`09b8c0f6`, an ancestor of production), but the Browser pane was
      hidden when the re-check was attempted, so it timed out. Anyone re-opening this box should
      load a real order at 375px and re-measure the field overflow before trusting the tick.
- [x] **D4. AI is INVISIBLE (standing owner rule, 2026-08-04).** AI assists heavily but is never
      announced: no "AI" labels, no sparkle icons, no "suggested by AI" copy, no model names —
      anywhere (UI, emails, exports, tooltips). Features present as Phoenix itself being smart:
      "Phoenix found a matching customer", "Details read from the invoice". All AI calls run
      server-side so nothing in the browser betrays a model. Applies to B4, B5, E2, E3 and
      anything AI-assisted later.

      **Closed by** [#1795](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1795) ·
      `tests/direct-orders-invoice-prefill.test.ts` — an EXECUTABLE sweep, not a promise: it
      strips comments and imports, extracts every user-visible string and JSX text node, and
      fails on `AI`, `GPT`, `OpenAI`, `LLM`, `model`, `confidence` or a sparkle. Repeated for the
      evidence reading in `tests/direct-orders-evidence-check.test.ts`.
## D5. Live report sharing (owner request, 2026-08-05 — added after Stage 1)

- [x] **D5a. Google Sheets feed.** A tokenized CSV endpoint a Google Sheet pulls with
      `=IMPORTDATA(...)`, so the sheet refreshes itself and can be shared with people who have no
      Phoenix account. Google's own sheet-sharing is the access control. Refresh is Google's
      cadence (~hourly), NOT instant.
      **Closed** · `tests/direct-orders-report-columns.test.ts` (column parity with the .xlsx —
      the first cut carried its own 25-column subset, so the live sheet and the export were two
      different reports on the day they shipped) + `tests/direct-orders-share-link-controls.test.ts`.
- [x] **D5b. Live web link.** Same data as a read-only page for a person with no account.
      **Passcode required**, carried in the POST body — never the query string, where it would
      land in browser history, referrer headers and proxy logs and look protected while leaking.
      **Closed by** [#1830](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1830) ·
      `tests/direct-orders-share-link-controls.test.ts`. Before it, the word *passcode* appeared
      **nowhere in the suite**. Locks: POST only (a passcode in a query string leaks to history,
      referrers and proxy logs — protected-looking while leaking), min 4 chars on the human
      surface, token-salted hash, constant-time compare.
- [x] **D5c. Controls, on by default.** 32-byte token · MANDATORY expiry (30d default, 180 max) ·
      one-click revoke · scope FROZEN to the creator at creation (a link cannot widen when its
      creator is promoted) · every open counted and stamped · `no-store` + `noindex` so a cached
      or crawled copy cannot outlive a revoke · Super Admin sees every link that exists.
      **Closed by** [#1830](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1830) ·
      `tests/direct-orders-share-link-controls.test.ts` — 32-byte token, expiry clamped to
      [1, 180] with 30 default and **no branch that writes a null**, revoke and expiry both
      refused, wrong-surface answers *not found* identically to missing, file access a separate
      grant, scope frozen at creation and never re-resolved, `no-store` + `noindex` on both
      routes (a cached or crawled copy outlives the expiry and the revoke button).
- [x] **D5d. Gated on EXPORT, not read.** Publishing the report outside the login wall is the
      strongest form of export; a reader who may not download the file must not be able to
      publish it instead.
      **Closed by** [#1830](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1830) ·
      `tests/direct-orders-share-link-controls.test.ts` — all three entry points gated on
      `export`, and the gate asserted to run **before** the first database call.
- [ ] ~~**D5e. Push into the Sheet** via the Google Sheets API~~ — **BLOCKED, and the outcome is
      already delivered another way.** The GCP org policy `iam.disableServiceAccountKeyCreation`
      forbids the key this needs, and GCP billing is closed besides (AGENTS §3). #1765 delivers the
      same result by inverting the direction: the Apps Script exposes a `doPost` webhook and Phoenix
      calls IT on every state change, so the sheet updates on approval without Google's poll and
      without any key. **Re-open only if the outcome is missing** — not merely because this box is
      unticked.

## E. Deterrence & reporting

- [x] **E1. Per-rep counters:** held, expired, refused-matches — visible to managers and owner.
      **Closed by** [#1780](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1780) ·
      `tests/direct-orders-rep-counters.test.ts` + `tests/direct-orders-counters-refused.test.ts`
      — the second exists because the counters went BLANK once the false pharmacies were
      rejected: they queried only `held`/`expired`, so solving the problem erased its record.
- [x] **E2. Vision check** on storefront evidence (is it a pharmacy; sign vs claimed name).
      **Closed by** [#1828](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1828) ·
      `tests/direct-orders-evidence-check.test.ts`. Read once when the rep files, verdict stored on
      `direct_order_pharmacy_validations.evidence_check`, shown at the Super Admin desk.
      **It ADVISES and must never gate** — same rule `AREA_PROXIMITY_FLAG_KM` already states. An
      Egyptian pharmacy may have a handwritten sign, an Arabic-only sign, or none; the test asserts
      that nothing in the decide path reads the column, so a future session cannot quietly promote
      it to a gate. Unknown renders as **"Could not read the sign"**, never as a pass.
- [ ] ~~**E3. Monday narrator brief** + Telegram delivery of held notices / phantom reports.~~
      **DECLINED by the owner, 2026-08-06** — asked directly, answered *"i dont want this brief"*.
      Not deferred, not blocked, not a backlog item. **Do not build this.** Held notices already
      reach requesters by email (C3/C4) and the counters (E1) already carry the standing picture.

## F. How delivery is guaranteed (the owner's question)

1. **This file is the contract.** Every requirement is a checkbox; nothing closes without a PR
   link + a named regression test. The file ships in the first PR and lives in `docs/specs/`.
2. **Every rule gets a test named after it** — wired into `tests/run-tests.ts` — so a future
   change that breaks an agreed rule fails CI with the rule's name in the failure.
3. **Phased delivery, each phase = one PR** with proof (test output, screenshots) mapped to the
   checkboxes it closes:
   - **Stage 1 — stop the chaos:** B1 B2 B3 B6 C3 C4 C5 (+ C1 already built), and the
     approval window D1 D2 D3 (owner escalated it — managers face it daily)
   - **Stage 2 — the gate:** A2 A3 B4 A4-cleanup, C2 badge
   - **Stage 3 — the polish:** B5, C6 audit, E1
   - **Cross-cutting from day one:** D4 (invisible AI)
   - **v2 later:** E2 E3
4. **Sessions forget; this file does not.** Any future session starts by reading this spec and
   the task list, not by trusting its own memory.

## G. Open owner decisions (blocking only their own items)

| # | Decision | Options |
|---|----------|---------|
| G1 | The 5 approved phantom orders (no sales injected — verified `sales_month` null on all 5) | reverse all 5 / leave approved, hold at Finance gate |
| G2 | The 10 pharmacies incl. 3 created 08-03 | hard delete vs deactivate; are the 08-03 three in scope? |
| G3 | Held expiry | confirm 14 days |
| G4 | Probation window | confirm 90 days |

## H. Nothing is left to build (closed out 2026-08-06)

**Every buildable box is closed.** The two still unticked are struck through above and are decisions,
not backlog: **D5e** is blocked by a GCP org policy and its outcome is already delivered by #1765's
webhook, and **E3** was declined by the owner outright. Neither should be rebuilt; re-open only if
the OUTCOME is missing, never because a checkbox looks empty.

D3 was the last one, and it took **two** PRs — worth stating, because the first one closed the box
before it was true. Desktop was already correct: three full tables, zero truncation, 50
`whitespace-nowrap`. Mobile did not exist at all, so the manager's phone showed two tables 820px and
760px wide behind a horizontal scroll, while four siblings in the same module — including the
employee-portal copy of that same screen — already rendered cards.
[#1833](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1833) fixed the tables and
**left the field grid at two columns**, on the reasoning that it already carried a breakpoint. At
375px that gave each value 150px while eight of them ran to 287px, and because every value is
`whitespace-nowrap` they did not wrap — they printed on top of the next column.
[#1836](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1836) fixed that.

**Only a browser could have caught it**, and that is the one thing to carry out of this box. After
#1833 the tables were provably desktop-only, the cards rendered, the page did not scroll sideways,
and nothing carried an ellipsis or wrapped. Every check true, every check green, screen unreadable.
Nothing in the markup was wrong, so no source-text test on that file could have found it. **Where a
requirement is about what a screen LOOKS like, a green suite is not evidence — open it at 375px.**

### The audit that got this wrong, and how

An audit earlier the same day put 21 boxes open and read as a long backlog. It was measuring the
wrong thing. It reconstructed coverage by reading **PR diffs**, so it saw which files a PR touched
but never saw the test suite that already guarded them. Six boxes were closed the whole time:

| Box | Was already locked by | Nobody had credited it |
|---|---|---|
| A1 | `direct-orders-approval-detail-names` | *"the order form must never mint a confirmed pharmacy"* |
| B1 | same | *"a stale type-ahead response must not overwrite a newer one"* |
| C5 | `direct-orders-approval-flow` | *"an assigned approver must always be able to open the request"* |
| D1 | `direct-orders-approval-detail-names` | *"the detail payload must resolve the area's medical rep"* |
| D2 | same | *"retail history must have its own loader, separate from direct orders"* — the table was real since #1665; [#1829](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1829) then added the part that genuinely was missing, the probation wording |
| D5a | `direct-orders-report-columns` | column parity with the .xlsx |

It also recorded **D2 as never built**, which was false — it grepped `src/components/direct-orders/`
and the file is at `src/components/approvals-hub/direct-order-request-detail.tsx`.

**The lesson is about the method, not the auditor.** A diff shows what changed; it cannot show what
is already protected. Coverage is a property of the suite, so read the suite. The cost of getting
this backwards is not a wrong number in a document — it is a future session rebuilding working code
because a box looked empty.

### The five that genuinely had nothing

B2, B3, D5b, D5c and D5d were real gaps, closed by
[#1830](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/1830). The share-link three are
worth naming: the word *passcode* appeared **nowhere in the suite**, and nothing asserted the expiry
clamp, revocation, or the frozen scope — on bearer credentials that serve pharmacy names, doctors,
quantities, prices and sales values to a reader with no Phoenix account.

### The one thing worth carrying forward

Every serious failure in this module has had the same shape: **something reporting success while
doing nothing.** A workflow-registry module that failed validation and was silently skipped, taking
the approval chain down in production with nothing logged. A capture button no rep could reach.
Counters that went blank the moment the problem they measured was solved. A status mapper that would
have rendered a *rejected* pharmacy as *verified*. An Arabic search whose probe normalized to the
empty string, so `ilike '%%'` matched all 51,192 rows and filled the screen with results.

TypeScript was green through every one of them. When reviewing this module, distrust anything that
reports success by rendering nothing — and distrust a full page of results as much as an empty one.
