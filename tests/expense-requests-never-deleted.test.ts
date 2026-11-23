/**
 * AN EXPENSE REQUEST IS NEVER DELETED, pinned.
 *
 * Owner, 24 Nov 2026, about 00:05 Cairo: "never delete any expense request. If rejected, keep them as
 * rejected, but never delete."
 *
 *   1. No code deletes a row of outstation_expense_requests: the admin delete is gone from the service.
 *   2. Both admin DELETE routes answer 405 with the one refusal, whoever sends them.
 *   3. Outstation Requests has no Delete button and sends no DELETE for a request.
 *   4. The System Cleanup Center no longer lists expense requests.
 *   5. The database refuses it too: BEFORE DELETE (each row) and BEFORE TRUNCATE triggers.
 *   6. The six requests deleted before the rule (7 Jun – 10 Oct 2026) still say "Request deleted" to the
 *      people who could see them: the notice reads their audit rows.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  OUTSTATION_REQUEST_NEVER_DELETED,
  OUTSTATION_REQUEST_NEVER_DELETED_CODE,
  outstationRequestNeverDeletedBody,
} from "@/lib/outstation/never-delete";

function source(relative: string) {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

/** Every .ts / .tsx file under the given folders, read once. */
function filesUnder(...folders: string[]) {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(rel);
      } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
        out.push({ file: rel.replace(/\\/g, "/"), text: fs.readFileSync(path.join(process.cwd(), rel), "utf8") });
      }
    }
  };
  for (const folder of folders) walk(folder);
  return out;
}

/** Code without its comments, so a comment naming the old delete never reads as the delete itself. */
function code(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export async function runExpenseRequestsNeverDeletedTests() {
  // 1. No code deletes a request.
  const service = code(source("src/lib/outstation/service.ts"));
  assert.doesNotMatch(
    service,
    /function deleteOutstationRequestAsAdmin/,
    "HEADLINE: the admin delete of an expense request must stay gone",
  );
  const deleters = filesUnder("src", "app", "scripts")
    .filter(({ text }) => /\.from\(\s*["']outstation_expense_requests["']\s*\)[^;]*?\.delete\(/.test(code(text)))
    .map(({ file }) => file);
  assert.deepEqual(deleters, [], "no code may delete a row of outstation_expense_requests");
  const cleanups = filesUnder("scripts")
    .filter(({ text }) => /safeDelete\(\s*["']outstation_expense_requests["']/.test(code(text)))
    .map(({ file }) => file);
  assert.deepEqual(cleanups, [], "a fixture script may not delete its expense requests either: the trigger refuses it");

  // 2. Both DELETE routes refuse, with 405 and the one sentence.
  const body = outstationRequestNeverDeletedBody();
  assert.equal(body.error, OUTSTATION_REQUEST_NEVER_DELETED_CODE);
  assert.equal(body.success, false);
  assert.match(OUTSTATION_REQUEST_NEVER_DELETED, /never deleted\. Reject it instead/, "the refusal must say what to do instead");
  for (const route of ["app/api/admin/outstation/[id]/route.ts", "app/api/admin/outstation/manager-expenses/[id]/route.ts"]) {
    const text = code(source(route));
    const del = text.slice(text.indexOf("export async function DELETE("));
    assert.ok(text.includes("export async function DELETE("), `${route}: the DELETE handler must answer, not 404`);
    const handler = del.split(/\n\}\n/)[0];
    const csrfAt = handler.indexOf("assertSameOriginMutation(request)");
    const accessAt = handler.indexOf('assertOutstationAdminAccess(await resolveAccessContext(request), "delete")');
    const refusalAt = handler.indexOf("NextResponse.json(outstationRequestNeverDeletedBody(), { status: 405 })");
    assert.ok(csrfAt >= 0 && accessAt > csrfAt, `${route}: DELETE must refuse a cross-site call, then a caller without access (401/403), first`);
    assert.ok(refusalAt > accessAt, `${route}: DELETE must then refuse with 405, touching nothing`);
    assert.doesNotMatch(handler, /from "@\/lib\/outstation\/service"|\.delete\(|getSupabaseAdmin/, `${route}: DELETE must touch nothing`);
    assert.doesNotMatch(text, /deleteOutstationRequestAsAdmin/, `${route}: must not reach a delete`);
  }

  // 3. Outstation Requests offers no delete.
  const admin = code(source("src/components/outstation/outstation-requests-admin.tsx"));
  assert.doesNotMatch(admin, /Delete expense/, "the Delete expense button must stay gone");
  assert.doesNotMatch(admin, /method:\s*"DELETE"/, "the page must send no DELETE for a request");
  assert.doesNotMatch(admin, /type AdminAction = [^;]*"delete"/, "delete is not an action on a request");

  // 4. The System Cleanup Center does not list them.
  const cleanup = code(source("src/lib/admin/system-cleanup.ts"));
  assert.doesNotMatch(cleanup, /"outstation_expenses"/, "the cleanup center must not offer expense requests");

  // 5. The database refuses a delete and a truncate.
  const migrationName = fs
    .readdirSync(path.join(process.cwd(), "supabase/migrations"))
    .find((name) => name.endsWith("_outstation_requests_never_deleted.sql"));
  assert.ok(migrationName, "the never-deleted migration must exist");
  const sql = source(`supabase/migrations/${migrationName}`).replace(/--.*$/gm, "");
  assert.match(
    sql,
    /create trigger phx_outstation_requests_never_deleted\s+before delete on public\.outstation_expense_requests\s+for each row/,
    "a BEFORE DELETE trigger must guard every row",
  );
  assert.match(
    sql,
    /create trigger phx_outstation_requests_never_truncated\s+before truncate on public\.outstation_expense_requests\s+for each statement/,
    "a BEFORE TRUNCATE trigger must guard the table: a row trigger never sees a truncate",
  );
  assert.match(sql, /raise exception 'expense requests are never deleted/, "the trigger must refuse, not skip in silence");
  assert.doesNotMatch(sql, /return\s+(old|null)\s*;/i, "returning OLD or NULL would let the delete through or skip it silently");

  // 6. The requests deleted before the rule still say so.
  assert.match(service, /export async function getDeletedOutstationRequestNotice/, "the old deletions keep their notice");
  assert.match(service, /\.like\("summary", "Admin deleted outstation request%"\)/, "the notice reads the old audit rows");
}
