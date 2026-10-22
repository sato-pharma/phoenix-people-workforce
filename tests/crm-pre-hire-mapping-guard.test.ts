import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  findPreHireMappingConflict,
  preHireMappingNotice,
  selectStampableVisitRowIds,
  type MappingCandidateRow,
  type StampCandidateRow,
} from "../src/lib/crm/admin.ts";
import {
  buildCrmIdentityMaps,
  isHandedOverLabel,
  isSettledUnmappedRow,
  normalizeCrmName,
  PREVIOUS_HOLDER_LABEL,
  previousHolderLabel,
  type CrmResolutionRow,
} from "../src/lib/crm/identity.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * PRE-HIRE MAPPING GUARD — the Unmapped Agents screen must refuse to create the miscredit that
 * tests/crm-pre-hire-attribution.test.ts exists to catch everywhere else.
 *
 * THE INCIDENT THIS PINS (production, 2026-08-28). The attribution guard shipped that morning and
 * cleared every automatically-resolved pre-hire row it walked. 1,373 rows survived it, across three
 * employees, because each of their CRM accounts had been MAPPED by hand from this screen — and the
 * resolver's tier 1 deliberately honours a human decision over the roster date. The largest was
 * 1,136 real doctor calls credited to a rep who joined 170 days after the earliest of them.
 *
 * WHY THE FIX IS HERE AND NOT IN THE RESOLVER. Guarding tier 1 would break the only route by which
 * a blocked row can ever be reassigned to whoever really made it — an admin's mapping is the
 * intended answer to the guard's own alert. crm-pre-hire-attribution section (J) pins that, and
 * section (B) of this file pins that the legitimate correction still goes through. The mistake is
 * made impossible to CREATE instead of overridden after the fact.
 *
 * WHY THE SCREEN COULD NOT SHOW THIS. When a CRM account is handed to a replacement, iReports360
 * rewrites the previous holder's historic rows with the NEW holder's name. So the admin sees one
 * consistent name across the account's whole history and nothing that looks wrong. The hire date is
 * the only evidence there is.
 */
export function runCrmPreHireMappingGuardTests() {
  const label = normalizeCrmName("Soad.Atef ( Cairo East 1 / A )");

  const row = (visitDate: string, rowLabel: string | null = "Soad.Atef ( Cairo East 1 / A )"): MappingCandidateRow => ({
    label: rowLabel,
    visitDate,
  });

  // ── (A) THE HEADLINE. A mapping that would credit work before the person joined is refused ──
  const conflict = findPreHireMappingConflict(
    [row("2026-01-01"), row("2026-03-14"), row("2026-06-01"), row("2026-07-15")],
    { decisionLabel: label, hireDate: "2026-06-20" },
  );
  assert.ok(conflict, "a mapping crediting visits dated before the hire date MUST be refused");
  assert.equal(conflict.count, 3, "every pre-hire row is counted, not just the first");
  assert.equal(conflict.earliest, "2026-01-01", "the earliest offending date is reported");
  assert.equal(conflict.latest, "2026-06-01", "the latest offending date is reported");

  // ── (B) The legitimate correction still goes through ────────────────────────────────────────
  //
  // This is the assertion that keeps the guard from being a cure worse than the disease. The whole
  // point of mapping a handed-over account is to file its history under the person who ACTUALLY
  // held it. That person's hire date precedes the rows, so nothing here may refuse it.
  assert.equal(
    findPreHireMappingConflict([row("2026-01-01"), row("2026-03-14"), row("2026-06-01")], {
      decisionLabel: label,
      hireDate: "2025-02-01",
    }),
    null,
    "mapping the slot to the person who really held it must still be allowed — that is the fix, " +
      "not the bug, and it is the only way a blocked row is ever reassigned",
  );

  // ── (C) The hire date itself is INCLUSIVE ───────────────────────────────────────────────────
  assert.equal(
    findPreHireMappingConflict([row("2026-06-20")], { decisionLabel: label, hireDate: "2026-06-20" }),
    null,
    "a visit ON the hire date was worked — it must not refuse the mapping",
  );
  assert.ok(
    findPreHireMappingConflict([row("2026-06-19")], { decisionLabel: label, hireDate: "2026-06-20" }),
    "one day before the hire date is still refused — there is no grace window here either",
  );

  // ── (D) No hire date recorded refuses nothing ───────────────────────────────────────────────
  //
  // Same rule isAttributableOn follows: an unknown start date is not evidence of anything. Two
  // active reps carry a NULL hire_date in production, and blocking their mappings would strand
  // real accounts with no way to resolve them.
  assert.equal(
    findPreHireMappingConflict([row("2020-01-01")], { decisionLabel: label, hireDate: null }),
    null,
    "an employee with no recorded hire date can still be mapped",
  );

  // ── (E) Label scoping matches the RESOLVER, which is not the same as the stamp ───────────────
  //
  // A row carrying somebody ELSE's label is not claimed by this decision, so it must not refuse it
  // — production slot 1399 carries three different people's names and the other two resolve
  // correctly on their own. But a row with NO label of its own IS claimed by tier 1
  // (`!recordLabel` passes), even though stampUnmappedVisitRows skips it. The refusal has to cover
  // every row the mapping would EVENTUALLY credit, not only the ones stamped the moment it saves.
  assert.equal(
    findPreHireMappingConflict([row("2026-01-01", "Tayseer.Khaled ( Cairo East 1 / E )")], {
      decisionLabel: label,
      hireDate: "2026-06-20",
    }),
    null,
    "another person's rows on a shared slot are not this decision's problem",
  );
  const unlabelled = findPreHireMappingConflict([row("2026-01-01", null)], {
    decisionLabel: label,
    hireDate: "2026-06-20",
  });
  assert.ok(
    unlabelled,
    "a row with NO label is claimed by tier 1 and must refuse the mapping — matching the stamp's " +
      "stricter equality here would let exactly those rows through",
  );
  assert.equal(unlabelled.count, 1, "the unlabelled row is the one counted");

  // A decision recorded without a label applies to the WHOLE slot, so everything on it counts.
  const blanket = findPreHireMappingConflict(
    [row("2026-01-01", "Tayseer.Khaled ( Cairo East 1 / E )"), row("2026-02-01", null), row("2026-03-01")],
    { decisionLabel: null, hireDate: "2026-06-20" },
  );
  assert.ok(blanket, "a label-less decision claims the whole slot, so any pre-hire row refuses it");
  assert.equal(blanket.count, 3, "every row on the slot counts when the decision carries no label");

  // ── (F) Whitespace variance must not defeat the label test ──────────────────────────────────
  //
  // The vendor emits the same person's label with inconsistent internal spacing, which is why both
  // sides go through normalizeCrmName. A raw string compare would read this row as someone else's
  // and wave the mapping through.
  assert.ok(
    findPreHireMappingConflict([row("2026-01-01", "Soad.Atef  ( Cairo East 1 / A )")], {
      decisionLabel: label,
      hireDate: "2026-06-20",
    }),
    "a stray double space in the vendor's label must still match the decision's label",
  );

  // ── (G) A timestamp compares by its DATE part ───────────────────────────────────────────────
  assert.ok(
    findPreHireMappingConflict([row("2026-06-19T23:59:00")], { decisionLabel: label, hireDate: "2026-06-20" }),
    "a timestamp on the day before the hire date refuses the mapping",
  );
  assert.equal(
    findPreHireMappingConflict([row("2026-06-20T00:05:00")], { decisionLabel: label, hireDate: "2026-06-20" }),
    null,
    "a timestamp on the hire date itself does not",
  );

  // ── (H) Nothing to judge ────────────────────────────────────────────────────────────────────
  assert.equal(findPreHireMappingConflict([], { decisionLabel: label, hireDate: "2026-06-20" }), null, "no rows");
  assert.equal(
    findPreHireMappingConflict([row("")], { decisionLabel: label, hireDate: "2026-06-20" }),
    null,
    "a row with no date cannot prove anything and must not refuse the mapping",
  );

  // ── (I) The message has to explain the handover, or the admin just retries ───────────────────
  //
  // The screen showed one consistent name across the whole account, so a bare "invalid mapping"
  // reads as a bug in the tool rather than a real finding about the data.
  const message = preHireMappingNotice({
    conflict: { count: 1136, earliest: "2026-01-01", latest: "2026-06-01" },
    employeeName: "Soad Atef",
    hireDate: "2026-06-20",
  });
  assert.ok(message.includes("Soad Atef"), "names the employee, never a bare HR ID");
  assert.ok(message.includes("2026-06-20"), "states the hire date being applied");
  assert.ok(message.includes("1136 visits"), "states how many visits were left unassigned");
  assert.ok(message.includes("left unassigned"), "says the mapping SAVED and those visits stayed unassigned — it no longer refuses");
  assert.ok(message.includes("2026-01-01") && message.includes("2026-06-01"), "states the offending range");
  assert.ok(
    message.includes("handed-over") || message.includes("previous holder"),
    "explains WHY the account looks correct on screen — otherwise the admin reads this as a tool bug",
  );
  assert.ok(
    /1 visit(?!s)/.test(
      preHireMappingNotice({
        conflict: { count: 1, earliest: "2026-01-01", latest: "2026-01-01" },
        employeeName: "Gannatallah Amer",
        hireDate: "2026-08-01",
      }),
    ),
    "a single offending visit reads as '1 visit', not '1 visits'",
  );
  assert.ok(
    preHireMappingNotice({
      conflict: { count: 1, earliest: "2026-01-01", latest: "2026-01-01" },
      employeeName: "Gannatallah Amer",
      hireDate: "2026-08-01",
    }).includes("dated 2026-01-01"),
    "one date is stated once, not as a range from itself",
  );

  // ── (J) The real production shape, end to end ───────────────────────────────────────────────
  //
  // Slot 1391 as it actually stood: every row relabelled to the new holder, 1,136 of them dated
  // across the 170 days before her start date (a rep logs many calls per day, so the dates repeat)
  // and 28 after it. The guard must refuse this, count all 1,136, and ignore the 28 that are hers.
  const dayBefore = (offset: number) =>
    new Date(Date.UTC(2026, 0, 1) + (offset % 170) * 86_400_000).toISOString().slice(0, 10);
  const slot1391: MappingCandidateRow[] = [
    ...Array.from({ length: 1136 }, (_unused, index) => row(dayBefore(index))),
    ...Array.from({ length: 28 }, () => row("2026-07-01")),
  ];
  const production = findPreHireMappingConflict(slot1391, { decisionLabel: label, hireDate: "2026-06-20" });
  assert.ok(production, "the production case refuses");
  assert.equal(production.count, 1136, "all 1,136 pre-hire rows are counted, and none of her own 28");
  assert.equal(production.earliest, "2026-01-01", "the earliest real offending date");
  assert.ok(production.latest < "2026-06-20", "the reported range never reaches into her employment");

  // ── (K) The Map button STAMPS only the chosen person's own tenure ───────────────────────────
  //
  // Slot 1399 (Tanta / A), production 2026-09-21. Every row carried the current holder's label, but
  // three people held it in turn. Mapping it to the FIRST holder passes the pre-hire guard above —
  // nothing predates her hire — and the old stamp then filed the SECOND holder's August calls under
  // her, seven weeks after she left. Only her own employment may be stamped.
  const tantaLabel = "Ahmed.Farag ( Tanta / A )";
  const nada = {
    crmId: null,
    crmUsername: null,
    hireDate: "2025-12-14",
    hrId: "B-97",
    lastWorkingDate: "2026-06-28",
  } as unknown as EmployeeDirectoryRow;
  const slot1399: StampCandidateRow[] = [
    { id: "jan", label: tantaLabel, visitDate: "2026-01-01" },
    { id: "last-day", label: tantaLabel, visitDate: "2026-06-28" },
    { id: "aug-other-rep", label: tantaLabel, visitDate: "2026-08-03" },
    { id: "sep-current-holder", label: tantaLabel, visitDate: "2026-09-06" },
    { id: "someone-else", label: "Tayseer.Khaled ( Cairo East 1 / E )", visitDate: "2026-02-01" },
  ];
  assert.deepEqual(
    selectStampableVisitRowIds(slot1399, { decisionLabel: normalizeCrmName(tantaLabel), employee: nada }),
    ["jan", "last-day"],
    "mapping a handed-over account to its first holder stamps ONLY her own tenure — never the rows " +
      "the next two holders logged after she left, and never another label",
  );

  // Before the hire date is never stamped either (the save-time guard refuses it; this is the floor).
  assert.deepEqual(
    selectStampableVisitRowIds([{ id: "early", label: tantaLabel, visitDate: "2025-12-13" }], {
      decisionLabel: null,
      employee: nada,
    }),
    [],
    "a row dated before the hire date is never stamped",
  );

  // Her OWN trailing work, logged after the last working day under her own label, is still hers —
  // the same exception the sync's resolver makes.
  const nadaWithLabel = { ...nada, crmUsername: "Nada.Elsharkawy ( Tanta / A )" } as EmployeeDirectoryRow;
  assert.deepEqual(
    selectStampableVisitRowIds(
      [
        { id: "own-late", label: "Nada.Elsharkawy  ( Tanta / A )", visitDate: "2026-06-30" },
        { id: "handed-over", label: tantaLabel, visitDate: "2026-06-30" },
      ],
      { decisionLabel: null, employee: nadaWithLabel },
    ),
    ["own-late"],
    "a post-exit row stays hers only while it carries her own label",
  );

  // Still-employed, no dates recorded: nothing to refuse on.
  assert.deepEqual(
    selectStampableVisitRowIds([{ id: "any", label: tantaLabel, visitDate: "2026-09-06" }], {
      decisionLabel: normalizeCrmName(tantaLabel),
      employee: { ...nada, hireDate: null, lastWorkingDate: null } as EmployeeDirectoryRow,
    }),
    ["any"],
    "an employee with no recorded dates is stamped as before",
  );

  // ── (L) The Unmapped Agents list stops listing rows that are already answered ───────────────
  //
  // Account 1537 (Alex East / A), production 2026-09-21: the current holder joined on 05-16 and the
  // account also carries 33 rows dated 05-07..05-15, relabelled with his name at the handover. The
  // owner's ruling: credit him from his hiring date. The 33 earlier rows are not his, so they are
  // settled and must drop off the list instead of keeping the account there forever. The list was
  // otherwise 21 accounts carrying nothing but public-holiday markers, which record no work.
  const alexLabel = "Ahmed.Nabil ( Alex East / A )";
  const nabil = {
    crmId: null,
    crmUsername: null,
    hireDate: "2026-05-16",
    hrId: "AI-0002",
    lastWorkingDate: null,
  } as unknown as EmployeeDirectoryRow;
  const mappedTo = (crmId: number, crmName: string | null) =>
    ({ crmId, crmName, mappedHrId: "AI-0002", status: "mapped" }) as unknown as CrmResolutionRow;
  const mapped = buildCrmIdentityMaps([nabil], [mappedTo(1537, alexLabel)]);
  // The real shape: his employees.crm_id IS 1537, so tier 2 answers after the refused override.
  const nabilOwnsSlot = { ...nabil, crmId: "1537", crmUsername: alexLabel } as unknown as EmployeeDirectoryRow;
  const mappedOwnSlot = buildCrmIdentityMaps([nabilOwnsSlot], [mappedTo(1537, alexLabel)]);
  const unmapped = buildCrmIdentityMaps([nabil], []);
  const slot = (visitDate: string, visitType: number, label: string | null = alexLabel, crmId: number | null = 1537) => ({
    crmId,
    label,
    visitDate,
    visitType,
  });

  assert.equal(isSettledUnmappedRow(slot("2026-05-07", 0), mapped), true, "a pre-hire call on a MAPPED account is settled — the mapping left it unassigned on purpose");
  assert.equal(
    isSettledUnmappedRow(slot("2026-05-07", 0), mappedOwnSlot),
    true,
    "still settled when his own crm_id is the account — tier 2's block must not keep it listed",
  );
  assert.equal(isSettledUnmappedRow(slot("2026-05-20", 0), mappedOwnSlot), false, "his in-tenure call on his own slot is not settled");
  assert.equal(
    isSettledUnmappedRow(slot("2026-05-07", 0), unmapped),
    false,
    "with no mapping and no crm_username on the roster, his label names nobody we know — still listed",
  );
  assert.equal(isSettledUnmappedRow(slot("2026-05-20", 0), mapped), false, "a call inside his employment is NOT settled — it is waiting to be stamped");
  assert.equal(
    isSettledUnmappedRow(slot("2026-05-07", 0, "Someone.Else ( Alex East / A )"), mapped),
    false,
    "a row carrying ANOTHER person's label is not covered by this mapping and stays on the list",
  );
  assert.equal(isSettledUnmappedRow(slot("2026-04-13", -5, "Batool.Rafiq ( Dakahlia 1 / C )", 1532), unmapped), true, "a public-holiday marker records no work");
  assert.equal(isSettledUnmappedRow(slot("2026-04-13", -6, "Batool.Rafiq ( Dakahlia 1 / C )", 1532), unmapped), true, "a casual-leave marker records no work");
  assert.equal(isSettledUnmappedRow(slot("2026-04-13", -8, "Batool.Rafiq ( Dakahlia 1 / C )", 1532), unmapped), false, "a campaign day is work and stays listed");
  assert.equal(isSettledUnmappedRow(slot("2026-04-13", -5, null, null), unmapped), false, "no account, nothing to settle");

  // ── (M) THE OWNER'S RULE: the list is clean except for a REAL unmapped agent ────────────────
  //
  // "I want this step to be always clean. Except when there is a real unmapped agent." (owner,
  // 2026-09-21). A row whose label names a known employee who was not employed that day is settled
  // with NO mapping: the roster already knows whose label it is, and the date rule already answers
  // the row. Before this, every joiner who inherited an account kept it on the list until somebody
  // mapped it by hand.
  const nabilOnRoster = { ...nabil, crmUsername: alexLabel } as unknown as EmployeeDirectoryRow;
  const knownNoMapping = buildCrmIdentityMaps([nabilOnRoster], []);
  assert.equal(
    isSettledUnmappedRow(slot("2026-05-07", 0), knownNoMapping),
    true,
    "a pre-hire call under a known employee's own label is settled with no mapping at all",
  );
  assert.equal(isSettledUnmappedRow(slot("2026-05-20", 0), knownNoMapping), false, "his in-tenure call is credited, never settled");

  // A REAL unmapped agent stays: a label nobody on the roster carries.
  assert.equal(
    isSettledUnmappedRow(slot("2026-05-07", 0, "Stranger.Name ( Tanta / P )", 9999), knownNoMapping),
    false,
    "a label that names nobody we know is a real unmapped agent and stays listed",
  );

  // A reused slot stays. The leaver still holds the crm_id, the vendor stripped her name, and real
  // calls arrive after she left. The label names nobody, so somebody unknown is doing this work.
  const behiraLeaver = {
    crmId: "1485",
    crmUsername: "Samia.Elgendy ( Behira 2 / C )",
    hireDate: "2026-01-05",
    hrId: "B-171",
    lastWorkingDate: "2026-07-11",
  } as unknown as EmployeeDirectoryRow;
  const stripped = "( Behira 2 / C )";
  assert.equal(
    isSettledUnmappedRow(slot("2026-08-26", 0, stripped, 1485), buildCrmIdentityMaps([behiraLeaver], [])),
    false,
    "real calls on a name-stripped account after its holder left stay listed",
  );
  // A mapping saved with no label names the account, never a person, so it cannot settle that row.
  const labellessMapping = { crmId: 1485, crmName: null, mappedHrId: "B-171", status: "mapped" } as unknown as CrmResolutionRow;
  assert.equal(
    isSettledUnmappedRow(slot("2026-08-26", 0, stripped, 1485), buildCrmIdentityMaps([behiraLeaver], [labellessMapping])),
    false,
    "a label-less mapping does not turn an unknown worker into a known one",
  );

  // A known person who WAS employed that day, but whom the waterfall could not reach, stays listed.
  // The leaver's crm_id answers first and blocks, so mapping the account is what credits the joiner.
  const behiraJoiner = {
    crmId: null,
    crmUsername: "Soad.Atef ( Behira 2 / C )",
    hireDate: "2026-07-15",
    hrId: "AI-0003",
    lastWorkingDate: null,
  } as unknown as EmployeeDirectoryRow;
  const handedOver = buildCrmIdentityMaps([behiraLeaver, behiraJoiner], []);
  assert.equal(
    isSettledUnmappedRow(slot("2026-08-26", 0, "Soad.Atef ( Behira 2 / C )", 1485), handedOver),
    false,
    "the joiner's own in-tenure call on the leaver's account is uncredited work by a known person — listed",
  );
  assert.equal(
    isSettledUnmappedRow(slot("2026-07-13", 0, "Soad.Atef ( Behira 2 / C )", 1485), handedOver),
    true,
    "the gap after the leaver left and before the joiner started is nobody's — settled",
  );

  // ── (N) A handed-over row prints "Previous holder", never the later holder's name ─────────────
  //
  // Owner, 2026-10-22: "once got data from phoenix crm then phoenix is the source of trust and its data
  // override old crm data". When an account changes hands iReports360 relabels its OLD rows with the new
  // holder's name — Osama Mohamed Ali's account, hired 1 Oct 2026, prints his name on 825 visits from May
  // to August. Phoenix's hiring date is the truth, so the CRM Master prints such a row as the previous
  // holder's, keeping the territory a board reads off the label.
  assert.equal(isHandedOverLabel(slot("2026-07-13", 0, "Soad.Atef ( Behira 2 / C )", 1485), handedOver), true, "a row before the named person's hire is handed over");
  assert.equal(isHandedOverLabel(slot("2026-08-26", 0, "Soad.Atef ( Behira 2 / C )", 1485), handedOver), false, "her own in-tenure call keeps her name");
  assert.equal(isHandedOverLabel(slot("2026-05-07", 0), knownNoMapping), true, "the 33 pre-hire rows on Alex East print as the previous holder's");
  assert.equal(isHandedOverLabel(slot("2026-05-20", 0), knownNoMapping), false, "his own call after his hire keeps his name");
  assert.equal(
    isHandedOverLabel(slot("2026-05-07", 0), unmapped),
    false,
    "with no crm_username on the roster his label names nobody Phoenix knows — the vendor's label stays",
  );
  assert.equal(
    isHandedOverLabel(slot("2026-05-07", 0, "Stranger.Name ( Tanta / P )", 9999), knownNoMapping),
    false,
    "a label that names nobody Phoenix knows is never relabelled — there is no hiring date to read",
  );
  assert.equal(isHandedOverLabel(slot("2026-05-07", 0, alexLabel, null), knownNoMapping), false, "no account, nothing to relabel");
  // Unlike the settled test, a no-work marker is NOT handed over by its type alone: only the hiring date decides.
  assert.equal(isHandedOverLabel(slot("2026-05-20", -5), knownNoMapping), false, "an in-tenure holiday marker keeps his name");

  assert.equal(PREVIOUS_HOLDER_LABEL, "Previous holder");
  assert.equal(previousHolderLabel("Soad.Atef ( Behira 2 / C )"), "Previous holder ( Behira 2 / C )", "the territory is kept");
  assert.equal(previousHolderLabel("  Osama.Mohamed ( Giza 3 / P )  "), "Previous holder ( Giza 3 / P )", "surrounding space is ignored");
  assert.equal(previousHolderLabel("Osama.Mohamed"), "Previous holder", "no territory, no brackets");
  assert.equal(previousHolderLabel(null), "Previous holder");
  assert.equal(previousHolderLabel(undefined), "Previous holder");

  // The CRM Master applies it on every path that prints an agent name: the paginated and exported visit
  // datasets (attachDerived, after the roster overlay) and both vacation paths. A check-in export carries
  // no agent name and asks for nothing.
  const master = readFileSync(new URL("../src/lib/crm/master.ts", import.meta.url), "utf8");
  assert.match(
    master,
    /attachAgentMeta\(rows, agentMeta, "agent_hr_id"\);\s*relabelHandedOverRows\(rows, identityMaps, "visit_date"\);/,
    "attachDerived relabels right after the roster overlay",
  );
  assert.equal(
    (master.match(/relabelHandedOverRows\(\w+, await loadIdentityMapsForLabels\(\w+\), "from_date"\);/g) ?? []).length,
    2,
    "the vacations page and the vacations export relabel by the period's first day",
  );
  assert.match(
    master,
    /dataset === "checkins" \? Promise\.resolve\(null\) : loadIdentityMapsOrNull\(\)/,
    "the export reads the identity maps once for the whole export",
  );
  assert.match(
    master,
    /if \(typeof row\.agent_hr_id === "string" && row\.agent_hr_id\.trim\(\)\) continue;/,
    "a row with an hr id is never relabelled — the door already prints that person's own name",
  );
}
