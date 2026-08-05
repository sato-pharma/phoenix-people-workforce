# Direct Orders V2 — Agreed Specification

**Date agreed:** 2026-08-04 (evening, after the module's first live day)
**Status:** Stage 1 shipped as [#1738](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1738)
and Stage 2 as [#1748](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1748); both are
merged and live. All six migrations those two PRs carried are applied in production — verified
2026-08-06 against `pg_class`/`pg_proc`, not the migration ledger. **7 of 28 items are closed**;
every remaining box is open, and section H records exactly what each one is still waiting on.
**Rule for every item:** it is DONE only when its checkbox is ticked with a link to the PR + the
test that locks it. Claims without proof do not close an item.

The one law behind everything: **money only moves on the map.** Nothing off the master customer
database ever touches approvals, sales, achievement, or incentives.

---

## A. Master data & trust

- [ ] **A1. Single source of truth.** Only distributor sales sheets create trusted customers
      (`source_of_sales_customer_map`). The order form NEVER creates a pharmacy record.
- [x] **A2. Pharmacy Validation flow** (modeled on Marketing Customer Validation, familiar to all
      staff): requester initiates from a held order → evidence required — **live camera storefront
      photo, GPS pinned inside the requester's own area** (no gallery uploads) + pharmacy details
      → lands on the **Super Admin validation desk** showing the evidence, the map pin, and the
      closest directory matches → SA either **matches to an existing code** (order rewires),
      **approves as new** (official code, provisional), or **rejects**.
      **Closed by** [#1748](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1748) ·
      `tests/direct-orders-pharmacy-validation.test.ts` — locks live-capture only ("the shutter must
      refuse before a location exists"), the server-computed area verdict ("the browser must never
      supply its own compliance verdict"), and all three SA outcomes incl. "rejecting must NOT
      confirm the pharmacy — the order stays held".
- [x] **A3. Probation (90 days).** An SA-approved pharmacy is *provisional* until a footprint
      confirms it: appears in a distributor sheet OR its collection is paid. Footprint → auto
      promote to trusted. No footprint in 90 days → **automatic phantom report** (pharmacy, order,
      value, **rep's name**) to owner + CEO.
      **Closed by** [#1748](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1748) ·
      `tests/direct-orders-pharmacy-validation.test.ts` — locks "the probation window is 90 days",
      both footprints ("distributor sales count", "a paid collection counts"), and the demotion of a
      provisional pharmacy "so a wrong approval self-corrects". Phantom report:
      `src/lib/direct-orders/phantom-report.ts`, swept by `/api/cron/direct-orders-probation`.
- [x] **A4. Cleanup of 2026-08-04 data.** The 10 hand-created pharmacies (DOP-000001..10) and
      their 12 requests migrate into the new states. **Open owner decisions:** see section G.

      **Closed 2026-08-05 by owner ruling:** all 12 pharmacies false → `rejected` + inactive,
      14 orders `rejected`, **0 sales injected** (every `sales_month` null, so nothing to unwind).
      The `rejected` state the ruling needed did not exist until #1804 ·
      `tests/direct-orders-pharmacy-rejected.test.ts`.
## B. Submission experience

- [ ] **B1. Combo box** over the live union of the customer directory + validated Phoenix
      pharmacies. No cached list — a pharmacy added by any route is findable immediately.
- [ ] **B2. Arabic-safe search**: normalized matching (ta-marbuta/ha, alef forms, ya/alef-maqsura,
      harakat stripped) on BOTH sides + **code search** (prefix, then contains). Unnamed customers
      (6,089) appear as `code — (no name on file)`, never hidden. (SQL migration
      `20260804183000_direct_order_customer_directory_search.sql` shipped in #1738 and **is applied
      in production** — `phx_normalize_arabic` and `phx_search_direct_order_customers` both confirmed
      live 2026-08-06. Box stays open: no test locks this search path. See H.)
- [ ] **B3. Area auto-fills from the chosen customer** (by AREA, per owner — not brick) and locks.
- [x] **B4. Did-you-mean (AI v1):** before a "new pharmacy" claim is accepted, show closest
      directory matches; **record shown-and-refused** on the request.
      **Closed by** [#1748](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1748) ·
      `tests/direct-orders-pharmacy-validation.test.ts` — locks "what Phoenix offered must be
      recorded on the claim", "the shown-and-refused record must be computed server-side, not taken
      from the client", and reproducibility ("suggestions use trigram similarity — deterministic, so
      the record reproduces identically later").
- [x] **B5. Invoice-photo prefill (AI v1):** photograph the distributor invoice → extract
      customer code, products, quantities → prefill the form.
      **Closed by** [#1795](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1795) ·
      `tests/direct-orders-invoice-prefill.test.ts` — locks that an unconfirmed customer code
      prefills NOTHING (no nearest-match fallback, asserted), that unmatched lines are named
      rather than dropped, and that it is mounted on BOTH submit forms.
- [x] **B6. Held lane.** Unknown pharmacy → submission allowed → status **HELD**: timestamped,
      enters NO approval chain, appears in NO approver queue, injects NOTHING. Requester sees a
      "Start pharmacy validation" path. **14-day expiry**: untouched held orders auto-expire,
      logged, counted per rep.
      **Closed by** [#1738](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1738) ·
      `tests/direct-orders-held-lane.test.ts` — locks "a held submit must seed NO approval steps —
      the chain is built at revival, not submission", "the clock defaults to 14 days (owner spec
      B6)", "held is NOT terminal — it has three live doors out", "expired is terminal — a dead end,
      not a pause", and "the expiry sweep must be CRON_SECRET-guarded".

## C. Approval workflow

- [x] **C1. Chain shape:** SFE Manager → requester's management line (person rungs) → CEO.
      **Super Admin is not a rung.** SA keeps: see-all, act-on-any-rung override, return-for-edit.
      **Closed by** [#1738](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1738) ·
      `tests/direct-orders-approval-flow.test.ts` + `tests/direct-orders-approval-detail-names.test.ts`
      — lock "the chain is SFE → sales line → CEO, with no acknowledgment rung wedged into it", "no
      chain may push a Super Admin rung — the rung is retired", "SFE must still be pushed onto the
      chain before the management line", and the retained SA-only path ("the standalone
      acknowledgment must stay Super Admin, never widen to the registry roles").
- [x] **C2. GOLDEN RULE — Finance month gate.** CEO approval never injects sales. Injection
      happens ONLY when the Finance Manager (HR_ID B-185, or SA) selects the order's month; null
      month = in no month. (Already live since #1666.) **UI must show the state in words:**
      "approved — awaiting Finance month" badge everywhere the order appears.
      **Closed by** [#1820](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1820) ·
      `tests/direct-orders-finance-month-badge.test.ts` — the badge now appears on all five
      surfaces via one shared pill, and the rule is EXECUTED across all ten status/month
      combinations, including the inverse error (a booked order must not show it).
- [x] **C3. Bulk held-notice button** (System Admin): select multiple held requests → one email
      per request — **To: requester BY NAME (never a code)**, CC: SFE Manager, direct manager,
      CEO — "held until you provide a valid pharmacy code; your pharmacy is not in the master
      database."
      **Closed by** [#1738](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1738) ·
      `tests/direct-orders-held-lane.test.ts` — locks "the notice must address the requester by
      NAME, never by code (owner rule)" and "a request that is no longer held must be SKIPPED —
      never email a stale demand". UI: `src/components/direct-orders/held-desk.tsx`.
- [x] **C4. ONE email, To + CC — never duplicate copies.** Every direct-order notification sends
      a single email: To = the concerned person, CC = the others. No more N copies of the same
      message.
      **Closed by** [#1738](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1738) ·
      `tests/direct-orders-held-lane.test.ts` — locks "the held notice must lead with the requester
      (the email's To) and CC SFE, direct manager, CEO"; the suite is registered in
      `tests/run-tests.ts` under "…one To/Cc email per event".
- [ ] **C5. Visibility from creation.** CEO, SFE, Super Admin, and every person in the request's
      chain can open it read-only from the moment it exists, with live step tracking. Action
      buttons appear only on your turn.
- [x] **C6. Deep workflow audit.** TS chain vs DB registry (both directions), every
      status/transition, `expectedNextStatus` couplings, notification fan-out, role gates incl.
      denial paths, held/returned/reversed edges, Finance gate. Deliverable: findings + fixes.

      **Closed by** [#1820](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1820) ·
      `docs/audits/direct-orders-workflow-audit.md` — 7 findings, all fixed (F1 caused a
      production outage). Each fix carries its own test; see the audit for the table.
## D. The approval window (premium)

- [ ] **D1. Comprehensive detail on one screen:** requester (name/role/area) · pharmacy (name,
      Phoenix code, all distributor codes, address, map pin, verification/probation state,
      validation evidence photos) · order lines (qty, bonus, discount, pharmacy price, value per
      the LOCKED pricing rule) · full chain history (who, when, wrote what) · collection date +
      payment state · Finance-month badge.
- [ ] **D2. Pharmacy sales history** from SoS shown to approvers (distributors, recent months,
      products, values). Provisional pharmacy → "no history — new pharmacy, probation day X/90"
      in words. An empty table must never read as zero.
- [ ] **D3. Premium, polished design** matching the module's design identity. Desktop = full
      tables; mobile = cards. No truncation, no wrapping. Owner emphasis (twice): the manager-
      facing approval experience is the face of the system — it must feel premium, complete, and
      never embarrassing.
- [x] **D4. AI is INVISIBLE (standing owner rule, 2026-08-04).** AI assists heavily but is never
      announced: no "AI" labels, no sparkle icons, no "suggested by AI" copy, no model names —
      anywhere (UI, emails, exports, tooltips). Features present as Phoenix itself being smart:
      "Phoenix found a matching customer", "Details read from the invoice". All AI calls run
      server-side so nothing in the browser betrays a model. Applies to B4, B5, E2, E3 and
      anything AI-assisted later.

      **Closed by** [#1795](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1795) ·
      `tests/direct-orders-invoice-prefill.test.ts` — an EXECUTABLE sweep, not a promise: it
      strips comments and imports, extracts every user-visible string and JSX text node, and
      fails on `AI`, `GPT`, `OpenAI`, `LLM`, `model`, `confidence` or a sparkle. Repeated for the
      evidence reading in `tests/direct-orders-evidence-check.test.ts`.
## D5. Live report sharing (owner request, 2026-08-05 — added after Stage 1)

- [ ] **D5a. Google Sheets feed.** A tokenized CSV endpoint a Google Sheet pulls with
      `=IMPORTDATA(...)`, so the sheet refreshes itself and can be shared with people who have no
      Phoenix account. Google's own sheet-sharing is the access control. Refresh is Google's
      cadence (~hourly), NOT instant.
- [ ] **D5b. Live web link.** Same data as a read-only page for a person with no account.
      **Passcode required**, carried in the POST body — never the query string, where it would
      land in browser history, referrer headers and proxy logs and look protected while leaking.
- [ ] **D5c. Controls, on by default.** 32-byte token · MANDATORY expiry (30d default, 180 max) ·
      one-click revoke · scope FROZEN to the creator at creation (a link cannot widen when its
      creator is promoted) · every open counted and stamped · `no-store` + `noindex` so a cached
      or crawled copy cannot outlive a revoke · Super Admin sees every link that exists.
- [ ] **D5d. Gated on EXPORT, not read.** Publishing the report outside the login wall is the
      strongest form of export; a reader who may not download the file must not be able to
      publish it instead.
- [ ] ~~**D5e. Push into the Sheet** via the Google Sheets API~~ — **BLOCKED, and the outcome is
      already delivered another way.** The GCP org policy `iam.disableServiceAccountKeyCreation`
      forbids the key this needs, and GCP billing is closed besides (AGENTS §3). #1765 delivers the
      same result by inverting the direction: the Apps Script exposes a `doPost` webhook and Phoenix
      calls IT on every state change, so the sheet updates on approval without Google's poll and
      without any key. **Re-open only if the outcome is missing** — not merely because this box is
      unticked.

## E. Deterrence & reporting

- [x] **E1. Per-rep counters:** held, expired, refused-matches — visible to managers and owner.
      **Closed by** [#1780](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1780) ·
      `tests/direct-orders-rep-counters.test.ts` + `tests/direct-orders-counters-refused.test.ts`
      — the second exists because the counters went BLANK once the false pharmacies were
      rejected: they queried only `held`/`expired`, so solving the problem erased its record.
- [x] **E2. Vision check** on storefront evidence (is it a pharmacy; sign vs claimed name).
      **Closed by** [#1828](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1828) ·
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

## H. Why the remaining boxes are still open (audited 2026-08-06, revised same day)

Almost all of these are **built and live in production** but cannot close, because rule 2 in
section F is that a box needs a named regression test wired into `tests/run-tests.ts`. Code shipping
is not the bar; a test that fails with the rule's name in it is. **An unticked box below is not a
missing feature — read the middle column before building anything.**

| Item | Code shipped? | What is missing |
|---|---|---|
| A1 single source of truth | Structural — A2/A3/B6 enforce it | Nothing names A1 itself; it is the sum of the three, not a separate build |
| B1 combo box | Yes, #1738 (`pharmacy-combo-box.tsx`, `/api/direct-orders/pharmacy-search`) | No test references either file |
| B2 Arabic-safe search | Yes, #1738; migration applied in prod | No test covers this search path (`customer-normalize`/`pharmacy-matching` are SoS-side) |
| B3 area auto-fill | Yes, #1738 (`/api/direct-orders/pharmacies/from-directory`) | No test |
| C5 visibility from creation | Partly, #1738 (registry grants) | `direct-orders-registry-chain-grants.test.ts` predates it (#1701) and locks SFE decision grants, not read-only-from-creation |
| D1 detail on one screen | Yes, #1738 (`direct-order-request-detail.tsx`, +142) | The test changed alongside it locks chain/pharmacy-verification rules, not D1's field inventory |
| D2 pharmacy sales history | **Yes, #1738** — the 2026-08-06 audit said "No"; that was **wrong**, it grepped `src/components/direct-orders/` and the file is at `src/components/approvals-hub/direct-order-request-detail.tsx`. Both halves ship: `loadPharmacyRetailHistory` (SoS distributor sales) and `loadPharmacyOrderHistory` (prior direct orders, this request excluded) | Only a test. The empty state the audit demanded already exists and reads *"No other direct orders recorded for this pharmacy yet — this is its first."* — not a zero |
| D3 premium design | Yes, #1738 | Needs browser verification at desktop + mobile, not a unit test |
| D5a Sheets feed | Yes, #1748 | Its tests arrived in #1754 and lock CSV **column parity** only |
| D5b live web link | Yes, #1748 | Nothing tests the passcode-in-POST-body rule |
| D5c controls | Yes, #1748 (`report-share-links.ts`) | Nothing tests expiry, revoke, scope-freeze, `no-store`/`noindex` |
| D5d gated on EXPORT | Yes, #1748 | No test asserts publish is gated on export, not read |
| ~~D5e Sheets push~~ | **Blocked** — org policy forbids the key | Nothing. #1765's webhook already delivers the outcome; see the item |
| ~~E3 Monday brief~~ | **Declined by the owner** | Nothing. Do not build it |

### Closed since that audit ran (same day)

The audit above was written before this session's work landed. These six moved from open to closed,
each with the named test rule F.2 requires:

| Item | PR | Test that locks it |
|---|---|---|
| A4 cleanup of the 2026-08-04 data | [#1804](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1804) | `direct-orders-pharmacy-rejected.test.ts` |
| B5 invoice-photo prefill | [#1795](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1795) | `direct-orders-invoice-prefill.test.ts` |
| C2 finance-month gate badge | [#1820](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1820) | `direct-orders-finance-month-badge.test.ts` |
| C6 deep workflow audit | [#1820](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1820) | `docs/audits/direct-orders-workflow-audit.md` — 7 findings, all fixed |
| D4 invisible AI | [#1795](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1795) | `direct-orders-invoice-prefill.test.ts` — an executable source sweep |
| E1 per-rep counters | [#1780](https://github.com/Gawish-1997/phoenix-people-workforce/pull/1780) | `direct-orders-rep-counters.test.ts` + `direct-orders-counters-refused.test.ts` |

**The one thing worth carrying forward.** The C6 audit's worst finding (F1) was a workflow-registry
module that failed validation and was **silently skipped** by `listWorkflowRegistryModules` — the
approval chain simply vanished in production and nothing logged an error. Three of this session's
other bugs had the same shape: a capture button no rep could reach, counters that blanked the moment
the problem they measured was solved, and a status mapper that would have rendered a *rejected*
pharmacy as *verified*. **TypeScript and the suite were green through every one.** When reviewing
this module, distrust anything that reports success by rendering nothing.
