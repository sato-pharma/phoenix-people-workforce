import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { accountJobTitle, displayTitleForAccount } from "../src/lib/auth/account-job-titles.ts";
import { displayTitleForRole } from "../src/lib/auth/hr-functions.ts";

// ─────────────────────────────────────────────────────────────────────────────
// An account is shown as its own job title, never as the permission key behind it.
//
// The owner, 2026-09-04: "in B-10 account, make his title as HR Section Head, not Super Admin."
// B-10 is his employee account; `employees.job_title` in production has read HR Section Head all
// along, and the screens were printing `app_auth_users.role` at him instead.
//
// THE TITLE IS HR MANAGER since 2026-10-09 ("update my job title to HR Manager") — he was promoted
// from HR Section Head. `positions.title` for his position (id 17) already read HR Manager, so the
// employee record was the half that lagged; it was corrected in the same change. The HR Section
// Head title is still live elsewhere on purpose — it is the seat he is RECRUITING for — so a sweep
// that finds it in the recruitment files has found the vacancy, not a missed rename.
//
// What this pins, in the order it can break:
//   1. the value itself, case-insensitively — HR ids are stored mixed-case here;
//   2. that it does NOT leak: every other account still reads its seat, and the two HR seat
//      titles keep resolving through displayTitleForRole;
//   3. the WIRING. A map nothing calls is the failure this repo has shipped before, so the three
//      resolvers that produce a viewer's label are asserted to call the account-aware function.
//      They are the whole surface: the identity strip and topbar chip read
//      resolveViewerIdentityFromPage, the shell's no-topbar path builds its own, and /admin/profile
//      states the title in prose.
// ─────────────────────────────────────────────────────────────────────────────

const WIRED_CALLERS = [
  "src/lib/auth/server.ts",
  "src/components/layout/app-shell.tsx",
  "app/(admin)/admin/profile/page.tsx",
];

export function runAccountJobTitlesTests() {
  // 1. The declared account, however its id is cased or padded.
  for (const spelling of ["B-10", "b-10", " B-10 "]) {
    assert.equal(
      displayTitleForAccount(spelling, "Super Admin"),
      "HR Manager",
      `B-10 must read as his job title, not the permission key (spelling ${JSON.stringify(spelling)})`,
    );
  }
  assert.equal(accountJobTitle("B-10"), "HR Manager");

  // The title belongs to the PERSON, not to the key he happens to hold, so it survives a role
  // change. If that is ever wrong the entry should be removed, not made conditional on the role.
  assert.equal(displayTitleForAccount("B-10", "HR Advisory"), "HR Manager");

  // 2. Nobody else moves. Every account without a declared title reads exactly what it read
  //    before this module existed.
  for (const [hrId, role] of [
    ["A-12", "Super Admin"],
    ["CN-0007", "Medical Rep"],
    [null, "Super Admin"],
    [null, "HR Advisory"],
    ["AI-0019", "HR Operations"],
    [undefined, null],
  ] as const) {
    assert.equal(
      displayTitleForAccount(hrId, role),
      displayTitleForRole(role),
      `${hrId ?? "an account with no HR id"} must still read as its seat`,
    );
    assert.equal(accountJobTitle(hrId), null);
  }

  // The live HR seats specifically — the case displayTitleForRole exists for — must still map. The
  // HR Business Partner title is gone with its seat (the owner retired the HR Business Partner seat on 2026-10-08).
  assert.notEqual(displayTitleForAccount("XX-1", "HR Advisory"), "HR Business Partner");
  // "HR Operations Coordinator" became "HR Generalist" on 2026-10-20 (owner: "make the old account HR
  // genralist"), the day the HR Operations Specialist seat (key "HR Administration") opened.
  assert.equal(displayTitleForAccount("XX-2", "HR Operations"), "HR Generalist");
  assert.equal(displayTitleForAccount("XX-3", "HR Resourcing"), "Talent Acquisition");
  assert.equal(displayTitleForAccount("XX-4", "HR Administration"), "HR Operations Specialist");

  // 3. The wiring. Each caller must ask the account-aware function, and none of them may still
  //    reach for the role-only one — that is exactly how a fix reaches some pages and not others.
  for (const file of WIRED_CALLERS) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(
      source.includes("displayTitleForAccount("),
      `${file} must resolve its viewer label through displayTitleForAccount`,
    );
    assert.ok(
      !source.includes("displayTitleForRole("),
      `${file} still calls displayTitleForRole, so its label ignores the account's own title`,
    );
  }
}
