import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { hrIdForStorage } from "../src/lib/hr-id.ts";

// Built for a real production repair. AccessContext.hrId is the LOWERCASE comparison key produced
// by canonicalHrIdKey — correct for matching, wrong for storage. Persisting it verbatim left 541
// lowercase actor ids across the weekly-plan tables (repaired 2026-09-02) and, on the audit that
// followed, ~37,000 more across 52 columns in 46 other tables.
//
// Nothing looks broken when it happens: the app's own lookups mostly canonicalise both sides, so a
// naive .eq is the only thing that feels it — and it then returns NOTHING rather than something
// wrong. That is the dangerous shape. In production it hid one approver's entire decision history
// (10 of 223 rows), and the same class of bug once hid 28% of reps' own orders.
//
// hrIdForStorage is exercised for real (hr-id.ts is pure, no Supabase client). The call sites are
// source-pinned across the whole repo, because reaching them needs a database — and because the
// regression being guarded is a NEW write site added later, which no behavioural test of today's
// sites would ever catch.

// A column that DELIBERATELY stores the lowercase comparison key (au.occupancy_history's
// occupant_canonical_hr_id is the only one in production, and no code path writes it from a
// session) would belong here, with the reason. Empty on purpose: there is currently no such write.
const DELIBERATE_COMPARISON_KEY_WRITES: string[] = [];

// ── THE DEBT THIS ONCE RECORDED IS PAID ─────────────────────────────────────────────────
//
// This map held 28 writes across marketing requests, direct orders and territory management, listed
// rather than hidden because each needed its READ side checked before its write could be wrapped.
// All 28 were repaired on 2026-09-05, together with a 29th the sweep could not see —
// pharmacy-license-verdict.ts wrote `license_name_checked_by_hr_id` from a PARAMETER
// (`input.actorHrId`), which is neither the inline expression nor the tainted local, so no pattern
// here would ever have found it. It surfaced only by reading the file the sweep had pointed at.
//
// TWO READS CHANGED IN THE SAME BREATH, which was the whole reason for the delay:
//
//   marketing-requests/report-share-links.ts read the column it writes with a plain lowercase
//   equality. Writes and reads were both lowercase, so it worked by accident; wrapping the write
//   alone would have stopped a non-admin seeing their own share links, returning nothing rather
//   than erroring. It now matches both spellings, like its direct-orders sibling always did.
//
//   direct-orders/pharmacy-validation.ts resolved requester names with `.in("hr_id", <raw column
//   values>)` against canonical employees.hr_id — already broken for every lower-cased row before
//   this change, rendering a real person as "(unknown — a-12)". Widened to both spellings.
//
// THE MAP STAYS, EMPTY. It is not dead weight: an entry means "known, counted, allowed for now",
// and having nowhere to record that is what pushes a future session to either fix a write it does
// not understand or delete the check. Empty is the honest state, and any new offender now fails
// through `unexpected` with the message that says how to fix it.
const KNOWN_UNREPAIRED_INDIRECT_WRITES: Record<string, number> = {};

const RAW_WRITE = /\b\w*_hr_id:\s*(?:input\.)?(?:access|ctx)\.hrId/;

// AND THE SAME WRITE ONE VARIABLE AWAY.
//
// The pattern above only sees `access.hrId` sitting INLINE beside the column. Assign it to a local
// first and the sweep goes quiet:
//
//     const actorHrId = access.hrId ?? null;
//     ...
//     status_changed_by_hr_id: actorHrId,
//
// That is not hypothetical. It is exactly how `updateCandidateStatus` wrote 125 lowercase rows into
// `ats_candidates.status_changed_by_hr_id` and 255 into `ats_candidate_status_events.actor_hr_id`
// while this file stayed green — three spellings for two people, so any per-person report splits
// one screener in two. Measured on production 2026-09-05, after the sweep had been passing for days.
//
// So the binding is followed: a `const` whose initialiser reads a session hr id and does NOT pass it
// through hrIdForStorage taints that name for the rest of the file, and writing the tainted name
// into an `_hr_id` column is the same offence as writing the expression.
const TAINTED_BINDING = /\bconst\s+(\w+)\s*=\s*(?:input\.)?(?:access|ctx)\.hrId\b/;

/** Names in this file that hold the raw comparison key. */
function taintedNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    // A line that already funnels through hrIdForStorage is the CORRECT shape, not an offence.
    if (line.includes("hrIdForStorage")) continue;
    const hit = TAINTED_BINDING.exec(line);
    if (hit) names.add(hit[1]);
  }
  return names;
}

function sourceFilesUnder(root: string) {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith("_wt-")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };
  walk(root);
  return found;
}

export async function runHrIdStorageCasingTests() {
  // --- the converter itself, run for real ---
  assert.equal(hrIdForStorage("a-9"), "A-9", "the lowercase comparison key must convert back to the casing employees.hr_id stores");
  assert.equal(hrIdForStorage("A-9"), "A-9", "an already-canonical id must pass through unchanged");
  assert.equal(hrIdForStorage("  a-12  "), "A-12", "surrounding whitespace must never reach storage");
  assert.equal(hrIdForStorage("aaa"), "AA", "the legacy aaa alias must resolve to the live employee id, not be stored as AAA");
  assert.equal(hrIdForStorage(null), null, "a null actor must stay null - never the string NULL");
  // A blank passes through unchanged rather than becoming null. That is deliberate: it is exactly
  // what shipped in the weekly-plan fix, and tightening it here would quietly change what a NOT NULL
  // actor column receives. The helper's job is CASING, not blank-handling.
  assert.equal(hrIdForStorage(""), "", "a blank must pass through untouched - changing it to null would alter what NOT NULL columns receive");

  // --- the single funnel exists, in the module that owns the casing contract ---
  const hrId = readFileSync("src/lib/hr-id.ts", "utf8");
  assert.ok(
    hrId.includes("export function hrIdForStorage(value: string | null | undefined) {")
      && hrId.includes("return canonicalHrIdForDisplay(value) ?? value ?? null;"),
    "hrIdForStorage must exist in hr-id.ts and convert through canonicalHrIdForDisplay - it is the one place that turns a comparison key back into a stored id",
  );

  // --- NO file may persist a raw session hr id, anywhere ---
  const offenders: string[] = [];
  for (const file of [...sourceFilesUnder("src"), ...sourceFilesUnder("app")]) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const tainted = taintedNames(lines);
    // Built once per file rather than per line: a binding declared near the top taints writes
    // hundreds of lines below it, which is precisely the distance that hid the status-event bug.
    const INDIRECT_WRITE = tainted.size
      ? new RegExp(`\\b\\w*_hr_id:\\s*(?:${[...tainted].join("|")})\\s*[,\n]`)
      : null;
    lines.forEach((line, index) => {
      const raw = RAW_WRITE.test(line);
      const indirect = INDIRECT_WRITE ? INDIRECT_WRITE.test(line) : false;
      if (!raw && !indirect) return;
      if (line.includes("hrIdForStorage")) return;
      const site = `${file.split(sep).join("/")}:${index + 1}`;
      if (DELIBERATE_COMPARISON_KEY_WRITES.includes(site)) return;
      offenders.push(`${site}  ${line.trim()}${indirect && !raw ? "   <- via a local binding" : ""}`);
    });
  }
  // Split the offenders into "already known and counted" and "new".
  const byFile = new Map<string, number>();
  const unexpected: string[] = [];
  for (const entry of offenders) {
    const file = entry.split(":")[0];
    if (file in KNOWN_UNREPAIRED_INDIRECT_WRITES) {
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
      continue;
    }
    unexpected.push(entry);
  }

  assert.deepEqual(
    unexpected,
    [],
    `these sites write the raw lowercase session key into an _hr_id column - wrap the value in hrIdForStorage(...) so the database keeps the canonical casing:\n${unexpected.join("\n")}`,
  );

  // The recorded debt may SHRINK or hold. It may never grow, and a file whose count has dropped must
  // have its number lowered here so the next reader is not told there is more left than there is.
  for (const [file, expected] of Object.entries(KNOWN_UNREPAIRED_INDIRECT_WRITES)) {
    const actual = byFile.get(file) ?? 0;
    assert.equal(
      actual,
      expected,
      actual > expected
        ? `${file} gained a raw hr-id write (${actual} now, ${expected} recorded) - wrap it in hrIdForStorage(...), and check the column's READ side in the same change`
        : `${file} now has ${actual} raw hr-id writes, fewer than the ${expected} recorded - lower the number in KNOWN_UNREPAIRED_INDIRECT_WRITES so the remaining debt is stated honestly`,
    );
  }

  // --- THE EXPRESSION, not the column: repo-wide ---
  //
  // One expression appeared 93 times in this repository:
  //
  //     resolveEmployeeIdentityId(access) ?? access.loginId ?? <fallback>
  //
  // `resolveEmployeeIdentityId` returns the LOWERCASE comparison key. Where the result is STORED,
  // that is the bug this whole file exists for; it is written as a local or a parameter, so no
  // pattern keyed on a column name can see it, which is why four copies were found one at a time.
  //
  // ── THE TWO WAYS TO GET THIS WRONG, IN OPPOSITE DIRECTIONS ──────────────────────────────────
  //
  // 1. CANONICALISE THE WHOLE EXPRESSION. The fallbacks are not hr ids: `system` means no session
  //    did this, a login id names no employee, and one variant falls back to `access.role`. Running
  //    the lot through hrIdForStorage stores SYSTEM, DEV.PREVIEW and SUPER ADMIN as the person who
  //    acted. Only the hr-id branch may be canonicalised.
  //
  // 2. SWEEP THE COMPARISON SITES TOO. Some of these resolve WHO IS ASKING, to match against other
  //    values — seat-area-scope decides which areas a manager sees, portal-sos-dashboard decides a
  //    rep's own dashboard, excuses compares the actor against the assigned manager. There the
  //    lowercase key is CORRECT, and canonicalising breaks a viewer's own scope: the same shape as
  //    the picker that once offered a Medical Rep the names of all 73 reps.
  //
  // So the exemptions are listed with reasons rather than left implicit, and each is a claim that
  // can be checked by opening the file.
  const AUDIT_LOGIN_ID = /actorLoginId/;
  const COMPARISON_WRAPPED = /canonicalHrIdKey\(|hrKey\(|normalizeHrId\(|normalizedHrKey\(/;
  const SCOPE_OR_COMPARISON_FILES = new Set([
    "src/lib/direct-orders/service.ts",
    "src/lib/double-visit-analytics/service.ts",
    "src/lib/excuses/service.ts",
    "src/lib/sales/monthly-closing-portal.ts",
    "src/lib/sales/seat-area-scope.ts",
    "src/lib/sales/portal-sos-dashboard.ts",
    "src/lib/sales/weekly/access.ts",
    // loginId FIRST by design - a LOGIN id field, the same contract as the audit log's actorLoginId.
    "src/lib/hiring-documents/service.ts",
    // Compared, never stored: the identity only keys the in-flight sharing map, so the same person's
    // identical download requests share one build (single-flight.ts). Nothing writes it anywhere.
    "app/api/business-review/pack/route.ts",
  ]);
  const RAW_ACTOR = /resolveEmployeeIdentityId\(\s*(?:access|accessContext|ctx)\s*\)\s*\?\?/;

  const rawActorSites: string[] = [];
  let actorSitesSeen = 0;
  for (const root of ["src", "app"]) {
    for (const file of sourceFilesUnder(root)) {
      const rel = file.split(sep).join("/");
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, index) => {
        if (!RAW_ACTOR.test(line)) return;
        actorSitesSeen += 1;
        // The CORRECT shape puts the hr id through hrIdForStorage FIRST and lets the markers fall
        // through untouched, so a line holding both is the repair, not the offence.
        if (line.includes("hrIdForStorage")) return;
        if (AUDIT_LOGIN_ID.test(line)) return;
        if (COMPARISON_WRAPPED.test(line)) return;
        if (SCOPE_OR_COMPARISON_FILES.has(rel)) return;
        rawActorSites.push(`${rel}:${index + 1}  ${line.trim()}`);
      });
    }
  }

  // A positive control. If the expression is ever renamed, every file reads as clean and this whole
  // sweep certifies nothing while looking green - the failure mode that let four copies survive.
  assert.ok(
    actorSitesSeen >= 80,
    `only ${actorSitesSeen} actor-resolution sites found; the expression this sweep keys on has `
      + "moved, so it is measuring nothing",
  );

  assert.deepEqual(
    rawActorSites,
    [],
    "these sites STORE the raw lowercase session key. Put ONLY the hr id through hrIdForStorage - "
      + "`hrIdForStorage(access.hrId) ?? <the existing chain>` - because canonicalising the whole "
      + "expression stores SYSTEM, DEV.PREVIEW or a ROLE NAME as the person who acted. If the value "
      + "is COMPARED rather than stored, the lowercase key is correct: add the file to "
      + `SCOPE_OR_COMPARISON_FILES with the reason:\n${rawActorSites.join("\n")}`,
  );

  // And the two repaired alongside their writes keep the marker fallback that makes them safe.
  const copilotAccess = readFileSync("src/lib/payroll/copilot/access.ts", "utf8");
  assert.ok(
    copilotAccess.includes('hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system"'),
    "the copilot actor must canonicalise ONLY the hr id and keep the `system` marker intact",
  );

  // --- the hiring-pack sink moved INTO a helper, and the pin had to follow it ---
  //
  // This block used to pin two literal lines:
  //
  //     updated_by_hr_id: hrIdForStorage(cleanText(actorHrId)),
  //
  // On 2026-09-05 those lines became `...updatedByStamp(actorHrId)`, because writing the column
  // UNCONDITIONALLY turned out to be a second, separate bug: an editor with no linked HR id
  // (admin-HR carries a NULL hr_id by design) stamped NULL over the previous editor. B-129's
  // profile lost Omar that way at 15:27 Cairo, three hours after the casing fix landed on it.
  //
  // So this test went red on a file that was MORE correct than when it was green - the classic
  // source-pinning failure, where a fixed literal false-fails the moment the code shifts. The
  // answer is to pin the PROPERTY through the helper, never to delete the assertion: the casing
  // guarantee is still owed, it just moved one level down.
  const hiringPack = readFileSync("src/lib/hiring-pack/service.ts", "utf8");
  assert.match(
    hiringPack,
    /const stored = hrIdForStorage\(cleanText\(actorHrId\)\);/,
    "updatedByStamp must still canonicalise - it is now the ONLY thing standing between "
      + "employee_hiring_profile.updated_by_hr_id and the lowercase session key",
  );
  assert.equal(
    (hiringPack.match(/\.\.\.updatedByStamp\(/g) ?? []).length,
    3,
    "and all three writers must go through it - the two profile savers and the document signature. "
      + "A site that stopped spreading the helper would be writing the column some other way",
  );

  // --- a column whose NAME hides it, and which does not hold only people ---
  //
  // `outstation_expenses.approved_by` feeds `expense_claims.decided_by_hr_id` through
  // phx_refresh_expense_claims. The sweep above matches `\w*_hr_id:`, so a column called
  // `approved_by` is invisible to it BY NAME no matter how the value is written - which is how
  // 71 lower-cased rows survived every pass of this file.
  //
  // The second assertion is the one that matters most, and it guards the OPPOSITE mistake.
  // Measured on production 2026-09-05 the column held three kinds of value: `b-10` (71 rows, a
  // real HR id), `system` (15 rows, a marker meaning no session decided this) and `dev.preview`
  // (1 row, a login id with no employee behind it). Running the whole expression through
  // hrIdForStorage - the obvious repair - would store SYSTEM and DEV.PREVIEW, and the claims
  // screen would answer "who decided this" with a shouty non-person. Only the HR-id branch may
  // be canonicalised.
  const outstationExpenses = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  assert.ok(
    outstationExpenses.includes("hrIdForStorage(accessContext.hrId)"),
    "outstation_expenses.approved_by must store the canonical HR id - it feeds "
      + "expense_claims.decided_by_hr_id, and no pattern in this file can catch it by column name",
  );
  assert.ok(
    /\?\?\s*"system";/.test(outstationExpenses),
    "the `system` marker must survive untouched - canonicalising the whole expression would "
      + "write SYSTEM into the column the claims screen reads as the person who decided",
  );

  // --- A FOURTH SHAPE: the call site names no column, and the sink names no session ---
  //
  // Found 2026-09-05 by re-counting production, NOT by any sweep in this file: lowercase actor ids
  // went 255 -> 262 while this file was green, seven rows written by real users between 14:00 and
  // 14:22 Cairo the same afternoon. Two columns took them: direct_order_events.actor_hr_id (b-185,
  // b-94) and employee_hiring_profile.updated_by_hr_id (b-10).
  //
  // ── WHY EVERY SWEEP ABOVE READS CLEAN ON IT ─────────────────────────────────────────────────
  //
  // The bug is split across two lines that are each individually innocent. The CALL SITE is
  // `actorHrId: access.hrId` - a camelCase FIELD name, so no pattern keyed on `\w*_hr_id:` can
  // match it, and no resolveEmployeeIdentityId and no `?? loginId` chain for the actor-expression
  // sweep to key on either. The SINK is `actor_hr_id: input.actorHrId` - the right column name, but
  // the value is a PARAMETER, not a local binding, so taintedNames() never sees it declared.
  //
  // Fourteen call sites in direct-orders/service.ts feed one sink. THAT is why the repair belongs at
  // the sink: fixing fourteen callers leaves the fifteenth free to reintroduce it, and the fifteenth
  // is what a future session writes. The same reasoning covers coaching_archived_evaluations
  // (`created_by` - a column name with no `_hr_id` in it at all, invisible BY NAME) and the three
  // hiring-pack writes, where the value is wrapped in cleanText() and so is not a bare identifier.
  //
  // cleanText FIRST, then canonicalise: cleanText turns a blank into null, and hrIdForStorage
  // deliberately passes a blank through untouched (asserted at the top of this file), so reversing
  // the order would store an empty string in a column that used to receive null.
  for (const [file, needle, why] of [
    [
      "src/lib/direct-orders/service.ts",
      "actor_hr_id: hrIdForStorage(input.actorHrId),",
      "direct_order_events is the single sink for fourteen `actorHrId: access.hrId` call sites in "
        + "that one file - it took five lowercase rows on 2026-09-05 alone",
    ],
    [
      "src/lib/coaching/archived.ts",
      "created_by: hrIdForStorage(cleanText(input.createdBy)),",
      "coaching_archived_evaluations.created_by has no `_hr_id` in its name, so no sweep in this "
        + "file can see it by column name - the same blind spot that hid outstation approved_by",
    ],
  ] as const) {
    assert.ok(
      readFileSync(file, "utf8").includes(needle),
      `${file} must funnel its actor column through hrIdForStorage AT THE SINK, not at the callers: `
        + `${why}. Expected to find: ${needle}`,
    );
  }

  // --- widening a read to both casings must not hand PostgREST an empty IN list ---
  //
  // `hrIdLookupKeys(null)` is `[]`, and `.in(col, [])` builds `col=in.()`, which PostgREST
  // rejects as a SYNTAX ERROR. So a viewer holding the export permission but no linked HR id
  // would 500 the screen rather than see an empty list. Both share-link readers answer that
  // case themselves. Latent in the direct-orders reader since it went casing-blind; found
  // 2026-09-05 only because the marketing reader was about to copy the same shape.
  for (const shareLinkModule of [
    "src/lib/marketing-requests/report-share-links.ts",
    "src/lib/direct-orders/report-share-links.ts",
  ]) {
    const text = readFileSync(shareLinkModule, "utf8");
    assert.ok(
      text.includes("const ownKeys = hrIdLookupKeys(access.hrId);"),
      `${shareLinkModule} must read its own key list into a binding it can measure before filtering on it`,
    );
    assert.ok(
      text.includes("if (ownKeys.length === 0) return [];"),
      `${shareLinkModule} must answer an empty key list itself - .in(col, []) is a PostgREST syntax error, so the screen 500s instead of showing no links`,
    );
  }

  // --- the write NO PATTERN IN THIS FILE CAN SEE ---
  //
  // The licence verdict persists the actor from a PARAMETER (`input.actorHrId`), which is neither
  // the inline `access.hrId` expression nor a tainted local, so the sweep above is blind to it and
  // always was. It is pinned by source because that is the only thing that can hold it: a future
  // edit that drops the wrapper would restore a silent lower-cased write with nothing red.
  //
  // The columns are built in ONE place, `licenseVerdictColumns`, shared by the request approver's
  // step and the licence-only Approve in Customer Pharmacy Mapping - so the wrapper is pinned
  // THERE, and both writers are pinned to go through it rather than to name the column themselves.
  const licenseVerdictColumns = readFileSync("src/lib/venues/pharmacy-license-verdict-columns.ts", "utf8");
  assert.ok(
    licenseVerdictColumns.includes("license_name_checked_by_hr_id: hrIdForStorage(input.actorHrId),"),
    "the licence verdict must store the canonical actor id - this write arrives as a parameter, so the repo-wide sweep in this file cannot catch it and nothing else will",
  );
  for (const writer of [
    "src/lib/marketing-requests/pharmacy-license-verdict.ts",
    "src/lib/customer-pharmacy-mapping/actions.ts",
  ]) {
    const text = readFileSync(writer, "utf8");
    assert.ok(
      text.includes("...licenseVerdictColumns("),
      `${writer} must write the verdict through licenseVerdictColumns, the one place the actor id is canonicalised`,
    );
    assert.ok(
      !/license_name_checked_by_hr_id\s*:/.test(text),
      `${writer} must not name the checked-by column itself - a second spelling of it would skip the canonical wrapper`,
    );
  }

  // --- the reads repaired ALONGSIDE their writes stay casing-blind ---
  //
  // Pinned because reverting either one is silent: both return an empty or nameless result rather
  // than an error, which reads as "this person has nothing" instead of "this query cannot see it".
  const marketingShareLinks = readFileSync("src/lib/marketing-requests/report-share-links.ts", "utf8");
  assert.ok(
    marketingShareLinks.includes(`query.in("created_by_hr_id", ownKeys)`),
    "a share-link creator must match created_by_hr_id in BOTH casings - the column holds canonical ids from 2026-09-05 and lower-cased ones before it",
  );
  assert.equal(
    marketingShareLinks.includes(`.eq("created_by_hr_id", access.hrId`),
    false,
    "the single-casing .eq on created_by_hr_id is back - a creator then sees an empty list of their own links rather than an error",
  );

  const pharmacyValidation = readFileSync("src/lib/direct-orders/pharmacy-validation.ts", "utf8");
  assert.ok(
    pharmacyValidation.includes(`hrIdLookupKeys(String(r.requested_by_hr_id ?? ""))`),
    "requester names must be looked up in both casings - a raw .in against canonical employees.hr_id rendered real people as \"(unknown - a-12)\"",
  );

  // --- and the read that this drift already broke stays casing-blind ---
  const directOrders = readFileSync("src/lib/direct-orders/service.ts", "utf8");
  assert.ok(
    directOrders.includes(`.in("decided_by_hr_id", hrIdLookupKeys(access.hrId));`),
    "the approver's own decision history must match decided_by_hr_id in BOTH casings - a bare .eq on the session key returned an empty history for the one approver whose rows were stored uppercase",
  );
  assert.equal(
    directOrders.includes(`.eq("decided_by_hr_id", access.hrId`),
    false,
    "the single-casing .eq on decided_by_hr_id is back - it silently hides an approver's entire history rather than erroring",
  );
}
