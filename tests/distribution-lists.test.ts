import assert from "node:assert/strict";

import {
  computeAliasDrift,
  isEmptySpec,
  matchesDistributionRule,
  resolveDistributionList,
  rolesWereDropped,
  sanitizeRoles,
  type DistributionCandidate,
  type DistributionListSpec,
} from "../src/lib/distribution-lists/spec.ts";

/**
 * A DISTRIBUTION LIST DECIDES WHO RECEIVES COMPANY MAIL, AND EVERY WAY IT CAN BE WRONG IS SILENT.
 *
 * Nothing here touches the database — the suite runs with PRODUCTION credentials and
 * APP_ENV=production (AGENTS.md §2.1), so the logic that picks recipients has to be provable
 * without a client that could reach a real table.
 *
 * 🔴 THE THREE FAILURES THIS PINS ARE ALL INVISIBLE AT RUNTIME.
 *
 * AN EMPTY DIMENSION READ AS "MATCHES NOBODY". Every rule field is optional, so the natural
 * defensive reading — a blank field excludes everyone — makes a list resolve to nobody the moment
 * a field is left blank. An empty audience raises no error and delivers no mail; it looks exactly
 * like a quiet success. The rule is the opposite: an empty dimension is NO CONSTRAINT.
 *
 * AN UNBOUNDED LIST READ AS "MATCHES EVERYBODY". The same optionality in the other direction is
 * worse: a list with every field blank would resolve to the entire company. A send like that is
 * unrecallable and looks like an official HR communication. It is refused, not sent.
 *
 * A CASE-SENSITIVE HR ID. Ids are stored mixed-case across tables, so an exclusion spelled "b-10"
 * against a stored "B-10" silently stops applying while still LOOKING present on the list — the
 * person the owner asked to leave off is mailed anyway.
 */

const BASE_SPEC: DistributionListSpec = {
  allEmployees: false,
  areaIds: [],
  departmentIds: [],
  description: "",
  enabled: true,
  excludedHrIds: [],
  externalEmails: [],
  includedHrIds: [],
  label: "Test list",
  lineIds: [],
  listKey: "test_list",
  positionIds: [],
  regionCodes: [],
  roles: [],
  rolesDropped: false,
};

function spec(overrides: Partial<DistributionListSpec> = {}): DistributionListSpec {
  return { ...BASE_SPEC, ...overrides };
}

function person(overrides: Partial<DistributionCandidate> & Pick<DistributionCandidate, "hrId">): DistributionCandidate {
  return {
    areaId: null,
    departmentId: null,
    displayName: overrides.hrId,
    lineId: null,
    positionId: null,
    regionCode: null,
    regionName: null,
    roles: [],
    workEmail: `${overrides.hrId.toLowerCase()}@satopharma.com`,
    ...overrides,
  };
}

export function runDistributionListsTests() {
  // ── An empty dimension is NO CONSTRAINT, never "matches nobody" ──────────────────────────────
  const rep = person({ hrId: "B-10", lineId: 3, roles: ["Medical Rep"] });
  assert.equal(
    matchesDistributionRule(rep, spec({ roles: ["Medical Rep"] })),
    true,
    "a list constrained only by role must match on role alone — requiring every other field would resolve it to nobody",
  );

  // ── AND across dimensions, OR within one ─────────────────────────────────────────────────────
  assert.equal(
    matchesDistributionRule(rep, spec({ lineIds: [3], roles: ["Medical Rep"] })),
    true,
    '"medical reps on line 3" matches a medical rep on line 3',
  );
  assert.equal(
    matchesDistributionRule(rep, spec({ lineIds: [4], roles: ["Medical Rep"] })),
    false,
    "a medical rep on the WRONG line is out — dimensions are ANDed, not ORed",
  );
  assert.equal(
    matchesDistributionRule(rep, spec({ roles: ["District Manager", "Medical Rep"] })),
    true,
    "two roles on one list is an OR — holding either one is enough",
  );
  assert.equal(
    matchesDistributionRule(person({ hrId: "B-11", lineId: 3 }), spec({ roles: ["Medical Rep"] })),
    false,
    "somebody holding no app role at all must not fall into a role-constrained list",
  );

  // ── A null field never satisfies a constrained dimension ─────────────────────────────────────
  assert.equal(
    matchesDistributionRule(person({ hrId: "B-12", roles: ["Medical Rep"] }), spec({ lineIds: [3] })),
    false,
    "a person with no line must not match a line-constrained list",
  );

  // ── Region is matched case-insensitively ─────────────────────────────────────────────────────
  assert.equal(
    matchesDistributionRule(person({ hrId: "B-13", regionCode: "ue-1" }), spec({ regionCodes: ["UE-1"] })),
    true,
    "region codes are stored in mixed case — a literal comparison silently drops a whole region",
  );

  // ── 🔴 NO RULE MATCHES NOBODY, NEVER EVERYBODY ───────────────────────────────────────────────
  // The asymmetry against "an empty dimension is no constraint" is the whole safety property:
  // reaching every employee must take a rule that genuinely covers them, never a blank form that
  // widens on its own.
  assert.equal(
    matchesDistributionRule(rep, spec()),
    false,
    "a spec stating NO rule must match nobody — the opposite reading makes a half-finished list address the whole company",
  );
  assert.equal(
    matchesDistributionRule(rep, spec({ excludedHrIds: ["Z-99"] })),
    false,
    "an exclusion is not a rule — a list carrying only an exclusion must not resolve to everyone-but-one",
  );
  assert.equal(isEmptySpec(spec()), true, "a list with every field blank says nothing and must be recognisable as such");
  assert.equal(isEmptySpec(spec({ roles: ["CEO"] })), false, "one rule field is enough");
  assert.equal(isEmptySpec(spec({ includedHrIds: ["B-10"] })), false, "a hand-picked list says something even with no rule");
  assert.equal(
    isEmptySpec(spec({ externalEmails: ["auditor@example.com"] })),
    false,
    "a list of only external addresses is legitimate — refusing it would silently drop the auditor",
  );

  // ── Exclusions win over the rule AND over a hand-added name ──────────────────────────────────
  const team = [
    person({ hrId: "B-10", displayName: "Amr", roles: ["Medical Rep"] }),
    person({ hrId: "B-11", displayName: "Bishoy", roles: ["Medical Rep"] }),
  ];
  const excluded = resolveDistributionList(spec({ excludedHrIds: ["B-11"], roles: ["Medical Rep"] }), team);
  assert.deepEqual(excluded.members.map((member) => member.hrId), ["B-10"], "an excluded person is off the list");
  assert.deepEqual(
    excluded.skipped.map((entry) => entry.reason),
    ["excluded"],
    "an exclusion is REPORTED, not silent — a recipient who quietly vanishes is the failure nobody sees",
  );

  const excludedAndIncluded = resolveDistributionList(
    spec({ excludedHrIds: ["B-11"], includedHrIds: ["B-11"], roles: ["District Manager"] }),
    team,
  );
  assert.deepEqual(
    excludedAndIncluded.members,
    [],
    "an exclusion beats a hand-added name — the owner's 'not him' must not be undone by the rule widening later",
  );

  // ── An unbounded or disabled list RESOLVES TO NOBODY, and says which ─────────────────────────
  // The guard is asserted on the resolver itself, not on the service that calls it: a check one
  // layer up protects only the call sites that remember it, and what it is guarding is a send to
  // every employee of a live pharmaceutical company.
  const ruleless = resolveDistributionList(spec({ excludedHrIds: ["B-11"] }), team);
  assert.deepEqual(ruleless.members, [], "a list stating no rule must never resolve to the whole company");
  assert.match(
    String(ruleless.refusedReason),
    /states no rule/,
    "a refusal must be REPORTED — a refused list and a genuinely empty audience are identical once both are an empty array",
  );

  // A list of only external addresses resolves, rather than being caught by the same guard.
  const externalOnly = resolveDistributionList(spec({ externalEmails: ["auditor@example.com"] }), team);
  assert.equal(externalOnly.refusedReason, null, "a list of only external addresses is not empty and must not be refused");
  assert.deepEqual(externalOnly.emails, ["auditor@example.com"], "it reaches exactly its external addresses");
  assert.deepEqual(externalOnly.members, [], "and pulls in no employee, because it states no rule");

  // A hand-picked list with no rule resolves to exactly its names.
  const handPicked = resolveDistributionList(spec({ includedHrIds: ["B-11"] }), team);
  assert.deepEqual(
    handPicked.members.map((member) => member.hrId),
    ["B-11"],
    "a rule-less list reaches its named people and nobody else",
  );

  const disabled = resolveDistributionList(spec({ enabled: false, roles: ["Medical Rep"] }), team);
  assert.deepEqual(disabled.members, [], "a switched-off list resolves to nobody");
  assert.match(String(disabled.refusedReason), /switched off/, "a switched-off list says so rather than reading as empty");

  assert.equal(
    resolveDistributionList(spec({ roles: ["Medical Rep"] }), team).refusedReason,
    null,
    "a bounded, enabled list is not refused — otherwise the guard would silence every real list",
  );

  // ── HR ids are matched on the canonical key, never the literal string ────────────────────────
  for (const spelling of ["b-11", "B-11", " b-11 "]) {
    const cased = resolveDistributionList(spec({ excludedHrIds: [spelling], roles: ["Medical Rep"] }), team);
    assert.deepEqual(
      cased.members.map((member) => member.hrId),
      ["B-10"],
      `"${spelling}" must exclude B-11 — a casing difference silently re-adds him and the mail goes out`,
    );
  }

  // ── A hand-added name joins without satisfying the rule, and says so ─────────────────────────
  const hybrid = resolveDistributionList(
    spec({ includedHrIds: ["C-99"], roles: ["Medical Rep"] }),
    [...team, person({ hrId: "C-99", displayName: "Hossam", roles: ["Marketing Manager"] })],
  );
  assert.deepEqual(
    hybrid.members.map((member) => member.hrId).sort(),
    ["B-10", "B-11", "C-99"],
    "a named person joins a rule-based list without holding the rule's role",
  );
  assert.equal(
    hybrid.members.find((member) => member.hrId === "C-99")?.via,
    "included",
    "the screen must be able to say WHY somebody is on a list — a rule match and a hand-added name are different facts",
  );

  // ── Somebody with no work email is surfaced, never dropped in silence ────────────────────────
  const noEmail = resolveDistributionList(
    spec({ roles: ["Medical Rep"] }),
    [person({ hrId: "B-12", displayName: "Mina", roles: ["Medical Rep"], workEmail: null })],
  );
  assert.deepEqual(noEmail.members, [], "a person with no work email cannot be mailed");
  assert.deepEqual(
    noEmail.skipped,
    [{ displayName: "Mina", hrId: "B-12", reason: "no_work_email" }],
    "an unreachable member is reported — otherwise the list silently shrinks as people are added without an email",
  );

  // ── External addresses ride alongside, and everything is deduped and lowercased ──────────────
  const withExternal = resolveDistributionList(
    spec({ externalEmails: ["Auditor@Example.com", "auditor@example.com"], roles: ["Medical Rep"] }),
    team,
  );
  assert.deepEqual(withExternal.externalEmails, ["auditor@example.com"], "external addresses are deduped case-insensitively");
  assert.deepEqual(
    withExternal.emails,
    ["b-10@satopharma.com", "b-11@satopharma.com", "auditor@example.com"],
    "the send set is members plus externals, deduped",
  );

  // ── A dead role name stops matching rather than lingering as a string nobody holds ───────────
  assert.deepEqual(
    sanitizeRoles(["Medical Rep", "Talent Acquisition", "HR Operations", 7, null]),
    ["Medical Rep", "HR Operations"],
    "a retired role must be dropped — a stale string silently matches nobody while still reading as a live audience",
  );

  // ── Alias drift: a leaver still on a company alias is the finding that matters ───────────────
  const drift = computeAliasDrift({
    activeEmails: ["amr@satopharma.com", "bishoy@satopharma.com"],
    expectedEmails: ["amr@satopharma.com", "bishoy@satopharma.com"],
    recordedEmails: ["amr@satopharma.com", "leaver@satopharma.com"],
  });
  assert.deepEqual(drift.toAdd, ["bishoy@satopharma.com"], "somebody on the list but not on the alias must be added by hand");
  assert.deepEqual(
    drift.toRemove,
    [{ email: "leaver@satopharma.com", reason: "left_company" }],
    "an address on the alias belonging to nobody still employed is a LEAVER still receiving company mail — a password reset does not close that",
  );
  assert.equal(drift.inSync, false, "an alias needing either change is not in sync");

  const movedOff = computeAliasDrift({
    activeEmails: ["amr@satopharma.com", "bishoy@satopharma.com"],
    expectedEmails: ["amr@satopharma.com"],
    recordedEmails: ["amr@satopharma.com", "bishoy@satopharma.com"],
  });
  assert.deepEqual(
    movedOff.toRemove,
    [{ email: "bishoy@satopharma.com", reason: "not_on_list" }],
    "somebody still employed but off the list is a routine membership change, NOT a leaver — the two must never read the same",
  );

  const clean = computeAliasDrift({
    activeEmails: ["amr@satopharma.com"],
    expectedEmails: ["Amr@Satopharma.com"],
    recordedEmails: ["amr@satopharma.com"],
  });
  assert.equal(clean.inSync, true, "casing alone is never drift — otherwise every alias reads as permanently wrong");

  // ── 🔴 A REGION MATCHES ON NAME **OR** CODE, and the reason is not tidiness ──────────────────
  // Measured in production 2026-09-11: 13 field employees carry a region_name with NO region_code,
  // and every single one of them is a District Manager. Matching the code alone would therefore
  // produce 20 silently EMPTY district-manager lists while the rep lists beside them looked
  // perfectly correct — the exact failure shape this module exists to make visible.
  const byCode = person({ hrId: "R-1", regionCode: "D1", regionName: null, roles: ["Medical Rep"] });
  const byName = person({ hrId: "R-2", regionCode: null, regionName: "Delta (1)", roles: ["Medical Rep"] });
  const elsewhere = person({ hrId: "R-3", regionCode: "D2", regionName: "Delta (2)", roles: ["Medical Rep"] });
  const deltaOne = spec({ regionCodes: ["Delta (1)", "D1"], roles: ["Medical Rep"] });

  assert.equal(matchesDistributionRule(byCode, deltaOne), true, "somebody carrying only the code is in");
  assert.equal(
    matchesDistributionRule(byName, deltaOne),
    true,
    "🔴 and somebody carrying only the NAME is in — code-only matching emptied every region DM list",
  );
  assert.equal(matchesDistributionRule(elsewhere, deltaOne), false, "another region stays out");
  assert.equal(
    matchesDistributionRule(person({ hrId: "R-4", regionCode: null, regionName: null, roles: ["Medical Rep"] }), deltaOne),
    false,
    "somebody with no region at all is out, not swept in by the widened match",
  );

  // ── 🔴 THE ONLY WAY TO ADDRESS THE WHOLE COMPANY IS TO SAY SO ────────────────────────────────
  const everyone = [
    person({ hrId: "B-10", roles: ["Medical Rep"], lineId: 1 }),
    person({ hrId: "C-1", roles: ["CEO"], lineId: 4 }),
    person({ hrId: "O-1", lineId: 4 }),
  ];
  const family = resolveDistributionList(spec({ allEmployees: true }), everyone);
  assert.equal(family.refusedReason, null, "an all-company list is not refused — it stated its rule");
  assert.deepEqual(
    family.members.map((member) => member.hrId).sort(),
    ["B-10", "C-1", "O-1"],
    "it reaches everyone, including seats no role or line rule would have caught",
  );
  assert.equal(
    isEmptySpec(spec({ allEmployees: true })),
    false,
    "the flag is a rule — without this an all-company list would be refused as a half-finished edit",
  );
  // And the guard it had to coexist with is untouched: blank STILL means nobody.
  assert.deepEqual(
    resolveDistributionList(spec(), everyone).members,
    [],
    "🔴 a blank list still reaches NOBODY — the flag must be the only route to everyone, never something a blank form falls into",
  );
  assert.equal(
    matchesDistributionRule(everyone[0], spec({ allEmployees: true, lineIds: [99], roles: ["CEO"] })),
    true,
    "all-employees ignores every other dimension — an all-company list plus a filter is a contradiction, and the explicit flag wins",
  );

  // 🔴 `enabled: false` IS THE ONLY THING BETWEEN THIS ROW AND THE WHOLE COMPANY, so it is pinned.
  // Review found the flag could be made to bypass the switched-off refusal and every assertion
  // still passed. Sato Pharma Family ships disabled; this is what keeps that meaningful.
  const familyOff = resolveDistributionList(spec({ allEmployees: true, enabled: false }), everyone);
  assert.deepEqual(familyOff.members, [], "a switched-off all-company list reaches NOBODY");
  assert.match(
    String(familyOff.refusedReason),
    /switched off/,
    "and it says why — a company-wide audience that silently resolved to nobody would read as working",
  );

  // 🔴 THE CASE THE MATCHER'S OWN GUARD ACTUALLY PROTECTS. A list with no rule dimension but one
  // hand-added name passes isEmptySpec, so it reaches the matcher for EVERY candidate — and only
  // `hasRuleDimension` returning false stops it resolving to the whole directory. The blank-list
  // assertion above never reaches the matcher at all (isEmptySpec refuses first), so without this
  // one that guard is untested on the only path that can reach it.
  const namedOnly = resolveDistributionList(spec({ includedHrIds: ["C-1"] }), everyone);
  assert.deepEqual(
    namedOnly.members.map((member) => member.hrId),
    ["C-1"],
    "a list with a name and no rule reaches exactly that name — never everyone the matcher was asked about",
  );

  // ── 🔴 A RETIRED ROLE NAME MUST NARROW A LIST, NEVER WIDEN IT ────────────────────────────────
  // sanitizeRoles drops a role that no longer exists in phoenixRoles, which is correct. What was
  // NOT correct is what happened next: `roles` became empty, an empty dimension means "no
  // constraint", and the list kept its line and region rules while quietly losing its role filter.
  // Measured against the live directory before this fix: retiring "Medical Rep" widened 23 lists by
  // 48 people, so every regional reps list silently gained its District Manager. Two role names
  // have already been retired in this repo, so this is a live trigger and not a thought experiment.
  assert.equal(
    rolesWereDropped(["Medical Rep"]),
    false,
    "a live role is not a dropped role",
  );
  assert.equal(
    rolesWereDropped(["A Role Retired Last Year"]),
    true,
    "a list naming only a role that no longer exists has had its roles dropped",
  );
  assert.equal(
    rolesWereDropped(["Medical Rep", "A Role Retired Last Year"]),
    false,
    "one surviving role still constrains the list — only losing them ALL is the dangerous case",
  );
  assert.equal(rolesWereDropped([]), false, "a list that never named a role has dropped nothing");
  assert.equal(rolesWereDropped(null), false, "a missing value is not a dropped role");

  // The matcher must refuse it OUTRIGHT rather than fall through to the remaining dimensions.
  // 🔴 LINE 4 IS LOAD-BEARING HERE, NOT AN ARBITRARY NUMBER. It is the line `everyone` actually
  // holds two people on, and NEITHER is a Medical Rep — a CEO and a seat with no role at all. So
  // "Medical Reps on line 4" resolving without its role filter picks up exactly the wrong people,
  // which is the widening this pins. Written first against line 3, which nobody in the fixture is
  // on: the assertion passed with the guard deleted, because `some` over no candidates is false.
  // A control that cannot fire proves nothing.
  const widenedByRename = spec({ lineIds: [4], roles: [], rolesDropped: true });
  assert.deepEqual(
    everyone.filter((candidate) => matchesDistributionRule(candidate, widenedByRename)).map((c) => c.hrId),
    [],
    "🔴 a list whose every named role was retired must match NOBODY — without the guard this returns C-1 and O-1, who are not Medical Reps at all",
  );
  // The control for the line above: the same two people ARE reachable when the rule is intact, so
  // the empty result above is the guard working rather than a fixture that matches nothing.
  assert.deepEqual(
    everyone.filter((candidate) => matchesDistributionRule(candidate, spec({ lineIds: [4] }))).map((c) => c.hrId).sort(),
    ["C-1", "O-1"],
    "the fixture really does hold two people on line 4 — otherwise the assertion above is vacuous",
  );

  // And the whole list is refused WITH A REASON, because an empty result that says nothing reads to
  // a programmatic sender exactly like a list that legitimately has no members today.
  const renamed = resolveDistributionList(spec({ lineIds: [4], roles: [], rolesDropped: true }), everyone);
  assert.deepEqual(renamed.members, [], "a list broken by a role rename reaches nobody");
  assert.match(
    String(renamed.refusedReason),
    /no longer exists/,
    "and it says so — silence here would read as 'nobody qualifies today' rather than 'this list is broken'",
  );

  // 🔴 THE ALL-COMPANY FLAG DOES NOT RESCUE IT. rolesDropped is checked ABOVE the allEmployees
  // branch deliberately: a spec carrying both a dead role and the company-wide flag is incoherent,
  // and resolving that to every employee is the worst available reading of it.
  assert.equal(
    matchesDistributionRule(everyone[0], spec({ allEmployees: true, rolesDropped: true })),
    false,
    "a dead role beats the all-company flag — an incoherent spec must never resolve to the whole company",
  );
}
