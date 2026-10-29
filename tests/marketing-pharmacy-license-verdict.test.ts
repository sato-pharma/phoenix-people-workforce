import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  licenseVerdictColumns,
  parseLicenseVerdict,
} from "../src/lib/marketing-requests/pharmacy-license-verdict.ts";
import { pharmacyLicenseVerdictLabel } from "../src/lib/venues/pharmacy-license.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The marketing half of "does the licence trade name match the shop sign?".
//
// Direct Orders has recorded this answer since 20260825120000. Marketing SHOWED both documents and
// recorded nothing, so the check existed as an invitation. What is under guard here is not that the
// control renders — it is the four things that make the answer worth trusting once it does:
//
//   1. It is stored where a routine edit cannot erase it.
//   2. `null` means nobody was asked, and is never rendered or written as a "no".
//   3. Recording it requires holding the request AND the pharmacy being on that request.
//   4. It flags. It never rejects.
//   5. It OUTLIVES the request. The desk that records it disappears the moment the request is
//      decided; the Customer Database register is then the only place the answer can still be read.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function runMarketingPharmacyLicenseVerdictTests() {
  const migration = readFileSync(
    new URL("../supabase/migrations/20260826160000_marketing_pharmacy_license_verdict.sql", import.meta.url),
    "utf8",
  );
  const serviceSource = readFileSync(
    new URL("../src/lib/marketing-requests/pharmacy-license-verdict.ts", import.meta.url),
    "utf8",
  );
  const routeSource = readFileSync(
    new URL("../app/api/marketing-requests/[id]/license-verdict/route.ts", import.meta.url),
    "utf8",
  );
  const approverSource = readFileSync(
    new URL("../src/components/marketing-requests/marketing-request-approver-detail.tsx", import.meta.url),
    "utf8",
  );
  const confirmSource = readFileSync(
    new URL("../src/components/employee-portal/marketing-request-decision-confirmation.tsx", import.meta.url),
    "utf8",
  );
  const marketingServiceSource = readFileSync(
    new URL("../src/lib/marketing-requests/service.ts", import.meta.url),
    "utf8",
  );
  const registerSource = readFileSync(
    new URL("../src/components/employee-portal/marketing-customer-database.tsx", import.meta.url),
    "utf8",
  );
  const directOrderDeskSource = readFileSync(
    new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url),
    "utf8",
  );

  // ── 1. THE HEADLINE: the verdict must not live on the request↔pharmacy link row ──────────────
  //
  // That table is deleted and re-inserted wholesale when a returned request is resubmitted, so a
  // verdict stored there would be erased by an edit nobody connects to the licence — and the screen
  // would silently go back to saying "not checked yet" with no trace it ever had been.
  {
    assert.match(
      migration,
      /alter table public\.marketing_pharmacies/,
      "the verdict columns must land on marketing_pharmacies — the grain the LICENCE itself is filed at",
    );
    assert.ok(
      !/alter table public\.marketing_request_pharmacies/.test(migration),
      "WIPEABLE HOME: marketing_request_pharmacies is deleted and re-inserted on resubmission, so a verdict stored there is erased by a routine edit",
    );
    assert.ok(
      !/marketing_request_pharmacies/.test(serviceSource),
      "the writer must never touch the link table either",
    );
    // The reason above is only true while resubmission really does delete those rows. If that ever
    // stops being true this assert fails, and whoever changed it gets to re-read the choice.
    // Resubmission is one database function now (phx_resubmit_marketing_request), so the delete
    // is read from its text rather than from the service.
    const resubmitFunction = readFileSync(
      new URL("../supabase/migrations/20261014140000_marketing_resubmit_atomic.sql", import.meta.url),
      "utf8",
    );
    assert.match(
      resubmitFunction,
      /delete from marketing_request_pharmacies where request_id = p_request_id;/,
      "resubmission still deletes every link row — the premise of storing the verdict elsewhere",
    );
  }

  // ── 2. Three-valued, by behaviour and not by inspection ─────────────────────────────────────
  {
    assert.equal(parseLicenseVerdict(true), true, "an explicit true is an answer");
    assert.equal(parseLicenseVerdict(false), false, "an explicit false is an answer");
    assert.equal(parseLicenseVerdict(null), null, "null clears");
    assert.equal(parseLicenseVerdict(undefined), null, "a missing field is NOT an answer");
    // The coercion traps. Each of these would otherwise land as a recorded verdict about a real
    // pharmacy that nobody actually looked at.
    for (const coercible of ["true", "false", "", 0, 1, {}, []]) {
      assert.equal(
        parseLicenseVerdict(coercible),
        null,
        `COERCED VERDICT: ${JSON.stringify(coercible)} must clear, never become a recorded answer`,
      );
    }
  }

  // ── 3. All three columns move together, or the CHECK refuses the write ──────────────────────
  {
    const answered = licenseVerdictColumns({ actorHrId: "HR-1", matchesSign: false, now: "2026-08-26T10:00:00Z" });
    assert.equal(answered.license_name_matches_sign, false);
    assert.equal(answered.license_name_checked_by_hr_id, "HR-1", "an answer must carry its author");
    assert.equal(answered.license_name_checked_at, "2026-08-26T10:00:00Z", "and its moment");

    const cleared = licenseVerdictColumns({ actorHrId: "HR-1", matchesSign: null, now: "2026-08-26T10:00:00Z" });
    assert.equal(cleared.license_name_matches_sign, null);
    assert.equal(
      cleared.license_name_checked_by_hr_id,
      null,
      "STRANDED AUTHOR: clearing must clear the author too, or the CHECK rejects the row",
    );
    assert.equal(cleared.license_name_checked_at, null, "and the timestamp with it");

    // The constraint that makes the above the only writable shape.
    const constraint = migration.slice(migration.indexOf("marketing_pharmacies_license_verdict_check"));
    assert.match(
      constraint,
      /license_name_matches_sign is null[\s\S]{0,160}license_name_checked_by_hr_id is null[\s\S]{0,160}license_name_checked_at is null/,
      "the CHECK must allow the all-null shape",
    );
    assert.match(
      constraint,
      /license_name_matches_sign is not null[\s\S]{0,180}license_name_checked_by_hr_id is not null[\s\S]{0,180}license_name_checked_at is not null/,
      "and require author and timestamp whenever a verdict is present",
    );
  }

  // ── 4. Authorization: the request gate, AND the pharmacy actually being on that request ──────
  {
    assert.match(
      serviceSource,
      /getMarketingRequestDecisionSummary\(requestId, "approve", access\)/,
      "the verdict must borrow the approver screen's own gate, so the right to record can never drift from the right to see",
    );
    // Without this, one held approval step would license stamping ANY pharmacy in the company.
    assert.match(
      serviceSource,
      /summary\.targetPharmacies\.some\(/,
      "OPEN WRITE: the pharmacy must be checked against the request's own target list, or any pharmacy id would be writable",
    );
    assert.match(
      serviceSource,
      /throw notFoundError\("That pharmacy is not on this marketing request\."\)/,
      "and a pharmacy that is not on the request must be refused",
    );
    assert.match(routeSource, /assertSameOriginMutation\(request\)/, "the mutation route must carry the CSRF gate");
  }

  // ── 5. A verdict about a licence that is not on file is refused — in code, because the CHECK
  //       cannot see across to marketing_evidence_files ─────────────────────────────────────────
  {
    const guard = serviceSource.slice(
      serviceSource.indexOf("if (matchesSign !== null) {"),
      serviceSource.indexOf("const actorHrId"),
    );
    assert.ok(guard.length > 0, "the licence-exists guard must still be there");
    assert.match(
      guard,
      /from\("marketing_evidence_files"\)/,
      "the guard must actually look for the licence row",
    );
    assert.match(
      guard,
      /eq\("evidence_type", MARKETING_PHARMACY_LICENSE_EVIDENCE_TYPE\)/,
      "and it must look for a LICENCE specifically — a storefront photo is not one",
    );
    // Clearing must stay possible even with no licence on file, or a verdict recorded before the
    // licence was replaced could never be withdrawn.
    assert.match(
      serviceSource,
      /Only on the way IN\. Clearing is always allowed/,
      "clearing must not be gated on a licence still existing",
    );
  }

  // ── 6. It flags, it never rejects (owner's standing rule) ────────────────────────────────────
  {
    const update = serviceSource.slice(
      serviceSource.indexOf('.from("marketing_pharmacies")'),
      serviceSource.indexOf("if (updateError) throw updateError;"),
    );
    assert.ok(update.length > 0, "the update must still exist");
    for (const forbidden of ["validation_status", "evidence_status", "active"]) {
      assert.ok(
        !new RegExp(`${forbidden}:`).test(update),
        `SILENT REJECTION: recording a licence mismatch must not write ${forbidden} — the system flags, it never rejects`,
      );
    }
    assert.match(serviceSource, /writeRequiredAuditLog\(\{/, "the write must be audited");
  }

  // ── 7. The screens: a control only where there is a licence, and never a blank that reads as a
  //       pass ──────────────────────────────────────────────────────────────────────────────────
  {
    assert.match(
      approverSource,
      /\{pharmacy\.licenseUrl \? \(\s*<LicenseNameCheck/,
      "the control must be offered only when a licence is actually on file",
    );
    assert.match(
      approverSource,
      /Does the licence trade name match the shop sign\?/,
      "and it must ask the question in the words the rest of the system uses",
    );
    assert.match(
      approverSource,
      /Not answered — optional/,
      "an unanswered check must say so, rather than looking like a completed one",
    );
    // The confirmation screen is the last thing before the decision. Silence there is the one thing
    // it must never be.
    assert.match(
      confirmSource,
      /not checked yet/,
      "READS AS A PASS: the decision screen must say 'not checked yet' out loud when nobody answered",
    );
    assert.match(
      confirmSource,
      /does NOT match/,
      "and it must state a mismatch in words, not by colour alone",
    );
  }

  // ── 8. THE SECOND HEADLINE: the answer has to still be readable after the request closes ──────
  //
  // Sections 1–7 guard the moment the verdict is RECORDED. That moment is on a screen that ceases
  // to exist: the approver's detail view is reachable only while a request is open, and once it is
  // approved the answer was write-only — recorded, audited, and unreadable by anyone. A check
  // nobody can consult afterwards is a check that only ever protected the approver's own afternoon.
  //
  // The Customer Database register is the permanent surface. These pin the chain that carries the
  // verdict onto it, and the two ways that chain fails QUIETLY.
  {
    // ── 8a. The loudest failure: a row that predates the column must read as UNASKED, not as a
    //        mismatch. `select("*")` returns whatever the table has, so a stale PostgREST schema
    //        cache, a not-yet-migrated environment, or any narrowed select leaves the field
    //        `undefined`. `Boolean(undefined)` is `false`, and `false` renders "Does NOT match" —
    //        which would accuse every pharmacy in the register of a failed identity check nobody
    //        ever ran. `== null` is doing real work here and is not a style preference.
    const mapper = marketingServiceSource.slice(
      marketingServiceSource.indexOf("function mapMarketingPharmacy(row: MarketingPharmacyDbRow)"),
      marketingServiceSource.indexOf("function mapDistributorCode("),
    );
    assert.ok(mapper.length > 0, "mapMarketingPharmacy must still exist — it is the only constructor");
    assert.match(
      mapper,
      /licenseNameMatchesSign: row\.license_name_matches_sign == null\s*\?\s*null\s*:\s*Boolean\(row\.license_name_matches_sign\)/,
      "ACCUSES EVERY PHARMACY: a missing license_name_matches_sign must map to null, not to false — `== null` catches the undefined a pre-migration row returns, and a bare Boolean() would print 'Does NOT match' across the whole register",
    );

    // ── 8b. And the register row must actually carry it, from the PHARMACY. The verdict is a fact
    //        about the shop, not about the link row that happens to point at it.
    assert.match(
      marketingServiceSource,
      /licenseNameMatchesSign: pharmacy\.licenseNameMatchesSign,/,
      "the Customer Database row must carry the verdict, or the permanent surface has nothing to show",
    );

    // ── 8c. One vocabulary, one place. The register and the approver's desk are read by the same
    //        person a day apart, and the same fact reworded reads as a different fact.
    assert.equal(
      pharmacyLicenseVerdictLabel(true),
      "Confirmed to match",
      "the wording a decided request showed must be the wording the register shows a year later",
    );
    assert.equal(
      pharmacyLicenseVerdictLabel(false),
      "Does NOT match",
      "a mismatch must be stated in words — colour alone does not survive a printout or a screenshot",
    );
    assert.equal(
      pharmacyLicenseVerdictLabel(null),
      "Not checked yet",
      "READS AS A PASS: an unasked verdict must be named out loud, never rendered blank",
    );
    assert.equal(
      pharmacyLicenseVerdictLabel(undefined),
      "Not checked yet",
      "READS AS A PASS: an absent verdict must be named, never blank",
    );
    assert.notEqual(
      pharmacyLicenseVerdictLabel(null),
      pharmacyLicenseVerdictLabel(true),
      "'nobody asked' and 'checked and fine' must never print the same words",
    );
    for (const [label, source] of [["the register", registerSource], ["the direct-order desk", directOrderDeskSource]] as const) {
      assert.match(
        source,
        /pharmacyLicenseVerdictLabel\(/,
        `${label} must read its wording from the shared helper — a second inline ladder is how the two ends of one check drift apart`,
      );
      assert.ok(
        !/"Confirmed to match"/.test(source),
        `${label} must not restate the verdict wording inline`,
      );
    }

    // ── 8d. Both layouts. The owner's standing rule is desktop tables, mobile cards — a column
    //        added to only one half is invisible to whichever audience uses the other.
    const registerHasDesktopColumn = /<th className="px-3 py-3">Licence vs Sign<\/th>/.test(registerSource)
      && /<td className="min-w-0 break-words px-3 py-3"><LicenseVerdictCell value=\{row\.licenseNameMatchesSign\} \/><\/td>/.test(registerSource);
    assert.ok(
      registerHasDesktopColumn,
      "the desktop table must carry a licence column with a matching cell — a header without a cell shifts every column after it",
    );
    assert.match(
      registerSource,
      /label: "Licence vs sign",\s*value: <LicenseVerdictCell value=\{row\.licenseNameMatchesSign\} \/>,/,
      "MOBILE BLIND SPOT: the phone card must show the verdict too — admin shows tables, mobile shows cards, and a finding on only one of them is a finding half the readers never see",
    );

    // ── 8e. A mismatch must be legible as words. Colour alone does not survive a printout, a
    //        screenshot pasted into WhatsApp, or a reader who cannot distinguish rose from slate.
    const cell = registerSource.slice(
      registerSource.indexOf("function LicenseVerdictCell("),
      registerSource.indexOf("function CustomerRowCard("),
    );
    assert.ok(cell.length > 0, "the verdict cell must still exist");
    assert.match(
      cell,
      /const label = pharmacyLicenseVerdictLabel\(value\);/,
      "every branch of the cell must render the shared label, not a colour and an empty span",
    );
    assert.equal(
      (cell.match(/\{label\}/g) ?? []).length,
      3,
      "all three states must print their words — true, false, and the null that is neither",
    );
  }
}
