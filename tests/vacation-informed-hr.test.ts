// Owner instruction, 2026-09-29: "in any av request on phx make yasmeena informed and make on her
// landing page appear on a vacation today." Owner, 2026-10-20, when she moved to her own seat: the
// informed notice belongs to the HR Generalist SEAT — "Both to you until the hire" — so it goes to
// whoever holds that seat and, while nobody does, to the Super Admin standing in.
//
// Two rules are pinned here, and each has one way of going wrong that nothing else would catch:
//
//  1. INFORMED IS NOT AN APPROVER. The obvious-looking implementation is to add the informed party to the
//     vacation approval chain, which would make every annual vacation in the company wait on a
//     third signature. So the informed recipient must stay out of `approval-flow.ts` entirely, and
//     its notification must carry no approve/reject affordance.
//  2. THE ABSENCE PANEL MUST NOT DRAW AN EMPTY LIST WHEN THE SOURCE FAILED. "Nobody is on a
//     vacation today" and "the query broke" look identical if a failed read collapses to `[]`, and
//     the first sentence on a broken morning is the misleading zero AGENTS.md §7 forbids.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sourcesFor } from "../src/lib/hr/command-center.ts";
import { stripComments } from "./support/comment-strip.ts";
import {
  buildOnVacationTodayRows,
  type OnVacationTodayRow,
} from "../src/lib/vacation/on-vacation-today.ts";
import {
  VACATION_INFORMED_SEAT,
  VACATION_INFORMED_TYPES,
  isVacationInformedType,
  resolveVacationInformedHrIds,
} from "../src/lib/vacation/informed-recipients.ts";

function src(path: string) {
  return readFileSync(path, "utf8");
}

// Comments are stripped with the repo's shared `stripComments`, never a local regex or a line-wise
// filter. `tests/comment-strip-ratchet.test.ts` enforces that: a line-by-line stripper judges a line
// by how it STARTS, so the continuation lines of a multi-line `{/* … */}` are scanned AS CODE while
// the line that opened it is dropped whole — taking any real code on it with it. The scan below
// needs the strip because this repo documents its rules IN PLACE: `hr-on-vacation-today.tsx`
// explains at length that it must carry no `rounded-*` class and no `overflow-x-auto`, so a raw
// substring scan fires on the explanation and never on a violation.

export function runVacationInformedHrTests() {
  // ── 1. Who is informed, and of what ─────────────────────────────────────────────────────────
  assert.equal(
    VACATION_INFORMED_SEAT,
    "HR Operations",
    "the informed party is the HR Generalist seat (role key HR Operations), never a named person — owner, 2026-10-20",
  );
  assert.ok(
    !/["']HR-\d/.test(stripComments(src("src/lib/vacation/informed-recipients.ts"))),
    "no person is named by HR id: a named recipient strands the notice the day the seat changes hands",
  );
  assert.deepEqual(
    [...VACATION_INFORMED_TYPES],
    ["annual"],
    "annual only — he named the AV, and widening it to sick/emergency is a product decision",
  );
  assert.ok(isVacationInformedType("annual"), "an annual vacation informs her");
  for (const other of ["sick", "emergency", "other", "compensatory", "", null, undefined]) {
    assert.ok(
      !isVacationInformedType(other),
      `"${String(other)}" must not inform her — only the annual vacation does`,
    );
  }

  assert.deepEqual(
    resolveVacationInformedHrIds({ alreadyNotifiedHrIds: ["C-4", "A-7"], informedHrIds: ["HR-020"], vacationType: "annual" }),
    ["HR-020"],
    "an annual vacation raised by somebody else informs the seat's holder",
  );
  assert.deepEqual(
    resolveVacationInformedHrIds({ alreadyNotifiedHrIds: [], informedHrIds: ["HR-020"], vacationType: "sick" }),
    [],
    "a sick request informs nobody extra",
  );
  // The dedupe is on the hyphen-stripped, case-folded key: both spellings occur in this data, and
  // a miss here sends a second, weaker copy of a notification that person is already getting.
  for (const spelling of ["HR-020", "hr020", "hr-020", "HR020"]) {
    assert.deepEqual(
      resolveVacationInformedHrIds({ alreadyNotifiedHrIds: [spelling], informedHrIds: ["HR-020"], vacationType: "annual" }),
      [],
      `"${spelling}" is already a recipient — the informed party must not be told twice`,
    );
  }
  // The stand-in for the empty seat is the Super Admin, who often sits in the approval chain — and
  // whose console login is the same human. Either way the owner gets the decision copy only.
  for (const chainId of ["B-10", "b10", "PHX-1", "phx-1"]) {
    assert.deepEqual(
      resolveVacationInformedHrIds({ alreadyNotifiedHrIds: [chainId], informedHrIds: ["B-10"], vacationType: "annual" }),
      [],
      `the owner standing in is already told as "${chainId}" — no second, informed-only copy`,
    );
  }
  assert.deepEqual(
    resolveVacationInformedHrIds({ alreadyNotifiedHrIds: ["A-7"], informedHrIds: ["HR-020", "hr-020", "HR-021"], vacationType: "annual" }),
    ["HR-020", "HR-021"],
    "every holder of the seat is informed, each person once",
  );

  // ── 2. She is informed, NOT made an approver ─────────────────────────────────────────────────
  const approvalFlow = src("src/lib/vacation/approval-flow.ts");
  assert.ok(
    !approvalFlow.includes("HR-009") && !approvalFlow.includes("informed-recipients") && !approvalFlow.includes("VACATION_INFORMED_SEAT"),
    "the approval chain must never name the informed recipient — every name in it gets an approval " +
      "step, an SLA clock and Approve/Reject buttons, which is the opposite of 'informed'",
  );

  const service = src("src/lib/vacation/service.ts");
  assert.match(
    service,
    /async function dispatchVacationInformed\(/,
    "the informed copy is dispatched by its own function, not folded into the approval recipients",
  );
  // The informed dispatch runs from the SUBMIT path only, and after the chain's own notifications.
  assert.match(
    service,
    /await dispatchVacationInformed\(\{/,
    "dispatchVacationSubmitted calls it — otherwise the module is dead code and she is told nothing",
  );
  const informedBlock = service.slice(
    service.indexOf("async function dispatchVacationInformed("),
    service.indexOf("async function dispatchVacationSubmitted("),
  );
  assert.ok(
    informedBlock.length > 200,
    "the informed dispatch body was not located — this test's other assertions would pass vacuously",
  );
  // The seat is resolved when the request is submitted — its holders, or its stand-in while empty.
  assert.match(
    informedBlock,
    /await resolveSeatOrStandInHrIds\(VACATION_INFORMED_SEAT, /,
    "the informed party is the seat's people at the moment of the request, falling back to the Super Admin while it is empty",
  );
  assert.match(
    informedBlock,
    /if \(!isVacationInformedType\(input\.request\.vacationType\)\) return;/,
    "a request that informs nobody costs no seat lookup",
  );
  // All THREE channels, owner 2026-09-30 ("yasmine informed in app email telegram"). He was asked
  // before the email was wired, which is what §4 requires; the answer is what this pins.
  assert.match(
    informedBlock,
    /channels: \["in_app", "email", "telegram"\]/,
    "in-app, email and Telegram — the owner's own answer on 2026-09-30, asked before any email was wired",
  );
  // The address is resolved from HER employee record, never written here and never left for the
  // stored policy to fill: the "general" policy's own recipient mode is the shared hr_notifications
  // inbox, so an empty `recipients` is how a shared mailbox silently stands in for a person and the
  // send is still logged as a success.
  assert.ok(
    !/\bemail:\s*\{/.test(informedBlock),
    "no email block: passing recipientHrId alone makes the layer resolve HER work address and " +
      "record recipientAddressUnresolved when it cannot, instead of falling back to a shared inbox",
  );
  assert.ok(
    !/hr_notifications|satopharma\.com/.test(informedBlock),
    "no hard-coded address and no shared inbox — the recipient is a person, resolved by HR ID",
  );
  assert.ok(
    !informedBlock.includes("buttons"),
    "no Telegram approve/reject button: there is nothing for her to decide",
  );
  assert.match(
    informedBlock,
    /priority: "normal"/,
    "a high priority says somebody must act; the whole point of this notification is that nobody does",
  );
  assert.match(
    informedBlock,
    /idempotencyKey: `vacation:\$\{input\.request\.id\}:request_submitted_informed/,
    "keyed per request and recipient, so a re-dispatch tells her once rather than twice",
  );
  assert.match(
    informedBlock,
    /\/hr\/leave-management\/vacation-report/,
    "it links to HER Vacation Report, not to the approver's decision page",
  );

  // ── 3. The absence panel: who loads it ──────────────────────────────────────────────────────
  const operations = sourcesFor("HR Operations");
  const resourcing = sourcesFor("HR Resourcing");
  assert.ok(
    operations.includes("vacationsToday"),
    "HR Operations' landing page loads today's absences — that is the owner's instruction",
  );
  // CHANGED 2026-10-13 BY THE OWNER, and this line is the edit rather than a second line arguing
  // with the first. It used to assert the opposite — that the Talent Acquisition seat, holding no
  // `time_attendance` function, is NOT shown the company's absences. Asked which of the generic
  // page's blocks should survive on her rebuilt overview, he named three to keep, and "On a
  // vacation today" was one of them. So `workforce_context` now declares the source: it is the one
  // function nobody else holds, which is why her seat gains it and no other page moves.
  assert.ok(
    resourcing.includes("vacationsToday"),
    "the Talent Acquisition seat's own overview shows today's absences — the owner kept that block " +
      "when he had the page rebuilt on 2026-10-13. It reaches her through `workforce_context`, " +
      "which no other seat holds, so this is her page and not a widening of time_attendance",
  );

  // ── 4. The absence rows ─────────────────────────────────────────────────────────────────────
  const today = "2026-09-30";
  const rows = buildOnVacationTodayRows(
    [
      {
        day_part: "full_day",
        department_name: "Sales",
        employee_hr_id: "B-1",
        employee_name: "Nosiba Salah Hassanin Moussa",
        end_date: today,
        id: "req-2",
        line_name: "Anti Infective",
        start_date: today,
        vacation_type: "emergency",
      },
      {
        day_part: "am_only",
        department_name: "Finance",
        employee_hr_id: "A-7",
        employee_name: "Amina Test Person",
        end_date: "2026-10-03",
        id: "req-1",
        line_name: null,
        start_date: "2026-09-28",
        vacation_type: "annual",
      },
    ],
    today,
  );

  assert.deepEqual(
    rows.map((row) => row.name),
    ["Amina Test Person", "Nosiba Salah Hassanin Moussa"],
    "sorted by name — every row covers the same day, so a date sort would be arbitrary",
  );
  const [amina, nosiba] = rows as [OnVacationTodayRow, OnVacationTodayRow];
  assert.equal(amina.typeLabel, "Annual Vacation", "the type reads as a name, never as `annual`");
  assert.equal(nosiba.typeLabel, "Emergency Vacation", "every vacation type is an absence, not just annual");
  assert.equal(amina.dayPartLabel, "AM only", "a half day is named, so it is not read as a whole one");
  assert.equal(amina.untilLabel, "until 03 Oct 2026", "an absence running past today says when it ends");
  assert.equal(nosiba.untilLabel, "last day today", "an absence ending today says so, rather than repeating the date");
  assert.equal(nosiba.meta, "Anti Infective", "the line is preferred as context when the record carries one");
  assert.equal(amina.meta, "Finance", "the department is the fallback when there is no line");
  assert.match(amina.href, /^\/hr\/leave-management\/vacation-report\?requestId=req-1$/, "each row opens its own request");

  // A row that cannot name the person still counts as an absence: it prints the HR ID rather than
  // being silently dropped, because a dropped row is an employee HR thinks is at work.
  const unnamed = buildOnVacationTodayRows(
    [{ employee_hr_id: "C-3", employee_name: "", end_date: today, id: "req-3", start_date: today, vacation_type: "annual" }],
    today,
  );
  assert.deepEqual(unnamed.map((row) => row.name), ["C-3"], "a nameless record falls back to the HR ID, never disappears");

  // ── 5. Approved only, and a failed read is not an empty day ──────────────────────────────────
  const loader = src("src/lib/vacation/on-vacation-today.ts");
  assert.match(
    loader,
    /\.eq\("status", "approved"\)/,
    "pending requests are not absences — somebody waiting on a manager is still at their desk",
  );
  assert.match(loader, /if \(error\) throw new Error\(error\.message\)/, "a database error throws so the caller can name the source as unavailable");

  const commandCenter = src("src/lib/hr/command-center.ts");
  assert.match(
    commandCenter,
    /onVacationToday: loaded\.vacationsToday \?\? null/,
    "a failed or unloaded source becomes null, NEVER [] — an empty array renders as 'nobody is off today'",
  );
  const panel = src("src/components/hr/hr-on-vacation-today.tsx");
  assert.match(
    panel,
    /if \(rows === null\) return null/,
    "the panel draws nothing for a null list rather than claiming the office is full",
  );
  assert.match(panel, /Nobody is on a vacation today\./, "an empty day is still stated in words (relevant even if empty)");

  // Locked look: no rounded corners, no ellipsis, no horizontal scroll (owner's golden rules).
  const panelMarkup = stripComments(panel);
  assert.ok(
    panelMarkup.includes("className=") && !panelMarkup.includes("SQUARE EDGES"),
    "the comment stripper did not work — the class scan below would pass vacuously",
  );
  for (const banned of ["rounded", "truncate", "overflow-x-auto", "min-w-["]) {
    assert.ok(
      !panelMarkup.includes(banned),
      `"${banned}" must not appear in the absence panel — square edges, no ellipsis, no horizontal scroll`,
    );
  }
}
