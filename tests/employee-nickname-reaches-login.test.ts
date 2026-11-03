// A nickname saved on the employee record must reach the login (owner's decision, 2026-11-03: every
// screen shows a person by their display name). `app_auth_users.name` is a separate copy that the top
// bar, the sender line and the notification fallback all read, and `upsertEmployee` never touched it.
//
// The write itself needs a database and this suite runs with production credentials, so the path and
// payload are driven through the real builder and only the wiring inside `upsertEmployee` is read as
// source, comments stripped so a sentence about the call can never stand in for the call.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loginNameSyncFor } from "../src/lib/employees/employee-directory.ts";
import { stripComments } from "./support/comment-strip.ts";

function code(path: string) {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

function functionBody(text: string, declaration: string) {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must still exist`);
  const rest = text.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

function testTheWriteCarriesTheDisplayName() {
  const withNickname = loginNameSyncFor({ full_name: "Mona Ahmed Khaled Hassan", hr_id: "PD-0014", nickname: "Mona Khaled" });
  assert.equal(withNickname?.payload.name, "Mona Khaled", "HEADLINE: the nickname is what the login shows");

  const cleared = loginNameSyncFor({ full_name: "Mona Ahmed Khaled Hassan", hr_id: "PD-0014", nickname: "  " });
  assert.equal(cleared?.payload.name, "Mona Ahmed Khaled Hassan", "a cleared nickname puts the full name back on the login");

  assert.equal(
    loginNameSyncFor({ full_name: "  ", hr_id: "PD-0014", nickname: "Mona" }),
    null,
    "a row with no full name writes nothing, rather than blank a login",
  );
  assert.equal(loginNameSyncFor({ full_name: "Mona", hr_id: "  ", nickname: null }), null, "no HR id names no login");
  assert.equal(loginNameSyncFor(undefined), null, "a save that returned no row writes nothing");
}

function testTheWriteFindsEveryLoginAndNoTestAccount() {
  const sync = loginNameSyncFor({ full_name: "Mona", hr_id: "PD-0014", nickname: null });
  assert.ok(sync, "a named employee produces a write");

  const [table, query] = sync.path.split("?");
  assert.equal(table, "app_auth_users", "the write lands on the login table");

  const params = new URLSearchParams(query);
  const hrIdFilter = params.get("hr_id") ?? "";
  for (const spelling of ["PD-0014", "pd-0014"]) {
    assert.ok(
      hrIdFilter.includes(`"${spelling}"`),
      `logins store hr_id in mixed case and PostgREST matches exactly, so ${spelling} must be asked for: ${hrIdFilter}`,
    );
  }
  assert.ok(hrIdFilter.startsWith("in.("), "every spelling is one in-list, not one PATCH per spelling");
  assert.equal(params.get("is_test_persona"), "is.false", "a test account keeps its own name");
}

function testUpsertEmployeeCallsItAndCannotFailTheSave() {
  const source = code("src/lib/employees/employee-directory.ts");
  const upsert = functionBody(source, "export async function upsertEmployee(");
  const save = upsert.indexOf('method: "POST"');
  const sync = upsert.indexOf("await syncLoginDisplayName(rows[0]);");
  assert.ok(save >= 0, "upsertEmployee still writes the employee with a POST");
  assert.ok(sync > save, "HEADLINE: the login is updated from the row the save returned, after the save");

  const syncBody = functionBody(source, "async function syncLoginDisplayName(");
  assert.match(syncBody, /try \{\s*await patchOptionalTable\(sync\.path, sync\.payload\);/, "it uses the file's own PATCH helper, inside the try");
  assert.match(syncBody, /catch \(error\) \{\s*logError\(/, "a failed login write is logged, never thrown into a save that already happened");
  assert.doesNotMatch(syncBody, /\bthrow\b/, "nothing in the sync can fail the employee save");
}

export async function runEmployeeNicknameReachesLoginTests() {
  testTheWriteCarriesTheDisplayName();
  testTheWriteFindsEveryLoginAndNoTestAccount();
  testUpsertEmployeeCallsItAndCannotFailTheSave();
}
