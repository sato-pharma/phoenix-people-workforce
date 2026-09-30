import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the manager's two screens on the phone (B3).
 *
 * Owner's plan, Phase 3: **a manager approving a plan from the car is the point.** The app carried
 * the rep's four sub-tabs and nothing else, so a District Manager could enter his own visits from the
 * field and had to find a laptop to approve the week his reps were waiting on. Team and "Needs you"
 * close that, and the three things that could go wrong with them are pinned here.
 *
 * ## 1. The tab is the SERVER's decision, never a role read on the phone
 *
 * `viewer.isManager` is a fact ABOUT the viewer, not a grant. An acting District Manager holds no
 * manager seat and an SFE Manager holds no territory of his own, so a phone that drew its tabs from a
 * role would disagree with the gate the service applies — in both directions. Every sub-tab is built
 * from `overview.tabs.*` alone.
 *
 * ## 2. "Needs you" rides on `tabs.team`, and NOT on `tabs.reports`
 *
 * `tabs.reports` is `hasScope` — true for a medical rep. Hanging the exceptions board on it would put
 * a board naming who is behind into the hand of the person it names, which is the one thing Golden
 * Rule #1 forbids. `tabs.team` admits the same audience the board's own server gate
 * (`readsTeamReports`) admits, so nobody is offered a tab whose read would then be refused. Both
 * predicates are asserted, because the pairing is only safe while they agree.
 *
 * ## 3. A decision posts what the web posts
 *
 * The phone writes through the three existing decide routes and adds none of its own. A field name
 * that drifts — `decision` against `action`, a missing `expectedVersion` — is a refusal the manager
 * reads as "it did not save", from the car, with no way to tell why.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

export function runPhoenixCrmMobileManagerTests(): void {
  const shell = read("mobile/src/app/(portal)/crm.tsx");
  const team = read("mobile/src/features/crm/team-screen.tsx");
  const board = read("mobile/src/features/crm/exceptions-screen.tsx");

  // ── 1. Six sub-tabs, every one of them the server's decision ───────────────────────────────────
  {
    const union = /type SubTab =([^;]+);/.exec(shell);
    assert.ok(union, "the phone still declares its sub-tabs as a union");
    const tabs = [...union[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
    assert.deepEqual(
      tabs,
      ["today", "visits", "list", "plan", "team", "exceptions"],
      "the phone's six sub-tabs, in order — Today first (A2) and the manager's two last",
    );

    const labels = /const SUB_TAB_LABEL: Record<SubTab, string> = \{([\s\S]*?)\n\};/.exec(shell);
    assert.ok(labels, "every sub-tab still has a label");
    for (const tab of tabs) assert.match(labels[1], new RegExp(`\\b${tab}:`), `the "${tab}" tab has no label`);

    // The builder reads the server's answer and nothing else.
    const start = shell.indexOf("const subTabs: SubTab[] = [");
    assert.notEqual(start, -1, "the sub-tab list is still built in one place");
    const builder = shell.slice(start, shell.indexOf("];", start));
    for (const tab of tabs) {
      assert.ok(
        builder.includes(`overview.tabs.${tab === "exceptions" ? "team" : tab}`),
        `the "${tab}" sub-tab must be built from the server's own flag`,
      );
    }
    assert.equal(
      /viewer\.(isManager|isRep|isSfeManager)|viewer\.role/.test(builder),
      false,
      "no sub-tab may be derived from a role — the server decides who gets which tab, and a role read here disagrees with it for an acting DM and for the SFE Manager",
    );
  }

  // ── 2. "Needs you" rides on tabs.team, whose audience is the board's own gate ───────────────────
  {
    assert.ok(
      shell.includes('...(overview.tabs.team ? (["exceptions"] as const) : []),'),
      "the exceptions sub-tab is gated on tabs.team",
    );
    assert.equal(
      shell.includes("tabs.reports"),
      false,
      "🔴 tabs.reports is `hasScope` — true for a MEDICAL REP. Hanging the board on it hands a rep the board that names him",
    );
    assert.ok(shell.includes("<TeamScreen") && shell.includes("<ExceptionsScreen"), "both manager screens are rendered");

    const overview = read("src/lib/phoenix-crm/server/overview.ts");
    assert.ok(
      overview.includes("team: viewer.isSuperAdmin || (scope.length > 0 && (viewer.managerSeats.length > 0 || viewer.basis === \"all\"))"),
      "tabs.team still admits the Super Admin, a company basis and a manager seat",
    );
    const access = read("src/lib/phoenix-crm/server/access.ts");
    assert.ok(
      access.includes("return viewer.isSuperAdmin || viewer.isSfeManager || viewer.basis === \"all\" || viewer.managerSeats.length > 0;"),
      "readsTeamReports still admits the same audience — if either predicate moves, the phone offers a tab the server refuses (or hides one it would allow)",
    );
    assert.ok(
      read("src/lib/phoenix-crm/server/exceptions.ts").includes("readsTeamReports"),
      "the board's service is gated by that predicate and not by a second copy of it",
    );
  }

  // ── 3. Team posts exactly what the browser posts ───────────────────────────────────────────────
  {
    const web = {
      // The browser's plan decisions live on the plan board since 2026-09-29 (plan-tab.tsx retired).
      plan: read("src/components/phoenix-crm/plan-board.tsx"),
      request: read("src/components/phoenix-crm/request-card.tsx"),
      unplanned: read("src/components/phoenix-crm/unplanned-visit-card.tsx"),
    };
    for (const [what, path] of [
      ["plan", "/api/phoenix-crm/plans/decide"],
      ["request", "/api/phoenix-crm/list/requests/decide"],
      ["unplanned", "/api/phoenix-crm/visits/unplanned"],
    ] as const) {
      assert.ok(team.includes(`"${path}"`), `the phone decides a ${what} through ${path}`);
      assert.ok(web[what].includes(`"${path}"`), `and so does the browser — ${path} must stay the one route for it`);
    }

    // The envelope key each route answers under; a wrong key reads as a successful save of undefined.
    for (const key of ['"plan"', '"visit"', '"request"']) {
      assert.ok(team.includes(key), `the phone reads the ${key} envelope back`);
    }

    // The fields. `expectedVersion` is what stops two managers overwriting each other's decision.
    assert.match(team, /action: decision === "positive" \? "approve" : "return"/, "a plan takes an ACTION of approve or return");
    assert.match(team, /decision: decision === "positive" \? "approve" : "refuse"/, "a visit and a request take a DECISION of approve or refuse");
    assert.ok(team.includes("expectedVersion: plan.version"), "a plan decision carries the version it was read at");
    assert.ok(team.includes("expectedVersion: visit.version"), "an off-plan decision carries the version it was read at");

    // The phone opens no route of its own.
    const posted = [...team.matchAll(/crmPost<[^>]*>\(\s*"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(
      [...new Set(posted)].sort(),
      ["/api/phoenix-crm/list/requests/decide", "/api/phoenix-crm/plans/decide", "/api/phoenix-crm/visits/unplanned"],
      "Team writes through the three existing decide routes and no others",
    );

    // A refusal without a note is a rep told "no" and nothing else.
    assert.ok(
      team.includes('setProblem("Write a note for the rep explaining why.");'),
      "the negative half of every decision demands a note before it is sent",
    );
    assert.match(team, /if \(decision === "negative" && !trimmed\)/, "and the demand is made before the post, not after it");

    // The caps are the mirrored constants, never a literal typed twice.
    for (const constant of ["PLAN_DECISION_NOTE_MAX", "UNPLANNED_DECISION_NOTE_MAX", "DROP_REASON_MAX"]) {
      assert.ok(team.includes(`noteMax={${constant}}`), `the note is capped by ${constant}, which the mirrors test holds to its web twin`);
    }
  }

  // ── 4. Team shows only what waits on HIM, and counts AM and PM apart ───────────────────────────
  {
    assert.match(
      team,
      /row\.plan !== null && row\.plan\.status === "submitted" && \(row\.canApprove \|\| row\.canReturn\)/,
      "a plan reaches the phone only when it is SENT and this viewer may act on it — the server's own flags, never a role",
    );
    assert.ok(team.includes("visit.canDecide"), "an off-plan visit reaches the phone only at a step this viewer decides");
    assert.ok(team.includes("request.canDecide"), "a request reaches the phone only where this viewer decides it");

    // The call-rate golden rule: AM and PM are reported APART and never joined by a slash.
    assert.ok(team.includes("${row.accounts} AM · ${row.doctors} PM"), "the plan's two halves are AM and PM, apart");
    assert.equal(/"[^"]*\b(Doctors|Accounts)\b/.test(team), false, "the module says AM and PM, never Doctors or Accounts");
    assert.equal(/\d+\s*AM\s*\/\s*\d*\s*PM|AM \/ PM/.test(team), false, "AM and PM are never joined with a slash");
  }

  // ── 5. The board shows what is wrong and invents nothing ───────────────────────────────────────
  {
    assert.ok(board.includes('section: "exceptions"'), "the board asks the reports route for its own section");
    assert.ok(board.includes('"report"'), "and reads the report envelope back");
    assert.ok(board.includes("view.rows.map("), "it renders the server's rows straight");

    // 🔴 The whole feature: a clean territory is ABSENT. A phone that filled the gaps back in — a
    // green row, an "all good" line per territory — would undo the board on the one screen where
    // scrolling costs most.
    assert.equal(
      /territories\.map\(|allTerritories|"OK"|"All good"|\bgreen\b/i.test(board),
      false,
      "the board must never list a clean territory — absence IS the feature",
    );
    assert.ok(
      board.includes("Nothing needs you"),
      "an empty board says so plainly, because an empty board is the GOOD outcome and must not read as a failed load",
    );

    // Nothing on it acts, and nothing on it comes from the location evidence.
    assert.equal(/crmPost|Approve|Refuse|onDecide/.test(board), false, "nothing on the board acts — it is a place to look, never a place to decide");
    assert.equal(
      /phoenix_crm_location_integrity|integrity|flagg?ed|spoof|\bmock\b/i.test(board),
      false,
      "the board is made of work NOT DONE, never of a judgement on anyone's honesty",
    );
  }

  // ── 6. Neither screen is scoped to the picked territory ────────────────────────────────────────
  //
  // Team is every decision waiting on him across his whole reach and the board is every territory in
  // it, so a `seatId` on either would silently narrow them to one rep — and re-keying on the picker
  // would throw away a refusal note he had half typed.
  {
    for (const [what, code] of [["Team", team], ["the board", board]] as const) {
      assert.equal(/seatId=\$\{|seatId: seatId|seatId\?:/.test(code), false, `${what} must not be narrowed to the chosen territory`);
    }
    assert.ok(shell.includes("key={`team|${test}`}"), "Team is keyed by test mode alone");
    assert.ok(shell.includes("key={`exceptions|${test}`}"), "and so is the board");
  }

  console.log("phoenix-crm mobile manager: OK");
}
