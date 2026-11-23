/**
 * ONLY THE OWNER DELETES AN EXPENSE REQUEST, BY HIS OWN PRESS — THE SYSTEM NEVER DOES, pinned.
 *
 * Owner, 24 Nov 2026, about 00:05 Cairo: "never delete any expense request. If rejected, keep them as rejected,
 * but never delete." Then, about 01:20, correcting it: "leave the delete the button i meant u never delete
 * automatic only i from system can delete".
 *
 *   1. The delete is refused to anyone but a real signed-in Super Admin session: never a system context, a
 *      dev-preview, a View as Seat or a test account (assertOwnerDeletesRequest).
 *   2. The service checks that before it touches anything, and the request row leaves only through the one
 *      database door, phx_owner_delete_outstation_request. No code deletes the row directly, and no fixture
 *      script deletes its requests.
 *   3. His Delete expense button and both delete routes stay, and reach that service.
 *   4. The database: the trigger lets a DELETE through only when the door opened it; a plain DELETE and every
 *      TRUNCATE are refused, and the door closes itself again.
 *   5. The six requests deleted before the rule keep their "Request deleted" notice.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type { AccessContext } from "@/lib/auth/permissions";
import { assertOwnerDeletesRequest } from "@/lib/outstation/request-delete-guard";

function source(relative: string) {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

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

/** Code without its comments, so a comment naming a delete never reads as the delete itself. */
function code(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const owner = { role: "Super Admin", source: "session" } as AccessContext;

export async function runExpenseRequestDeleteOwnerOnlyTests() {
  // 1. Only the owner's own session may delete.
  assert.doesNotThrow(() => assertOwnerDeletesRequest(owner), "HEADLINE: the Super Admin, signed in as himself, deletes");
  const refused: Array<[string, AccessContext]> = [
    ["a system context (a cron, a job, a script)", { ...owner, source: "system" } as AccessContext],
    ["another role", { ...owner, role: "CEO" } as AccessContext],
    ["a dev-preview", { ...owner, source: "dev-header" } as AccessContext],
    ["a View as Seat", { ...owner, seatView: { hrId: "B-1" } } as unknown as AccessContext],
    ["a test account", { ...owner, testPersona: { hrId: "B-1" } } as unknown as AccessContext],
  ];
  for (const [who, access] of refused) {
    assert.throws(() => assertOwnerDeletesRequest(access), /cannot delete an expense request|never deletes one/, `HEADLINE: ${who} must never delete a request`);
  }

  // 2. The service checks first, and the row leaves only through the one door.
  const service = code(source("src/lib/outstation/service.ts"));
  const start = service.indexOf("export async function deleteOutstationRequestAsAdmin(");
  assert.ok(start >= 0, "the owner's delete must exist: he keeps his Delete button");
  const body = service.slice(start, service.indexOf("\n}\n", start));
  const guardAt = body.indexOf("assertOwnerDeletesRequest(access)");
  assert.ok(guardAt >= 0, "the delete must check that the owner pressed it");
  assert.ok(guardAt < body.indexOf("getOutstationRequestById("), "the owner check must come before anything is read");
  assert.ok(guardAt < body.indexOf(".delete("), "the owner check must come before anything is deleted");
  assert.match(body, /\.rpc\("phx_owner_delete_outstation_request", \{ p_request_id: requestId \}\)/, "the request row must leave through the one door");
  const deleters = filesUnder("src", "app", "scripts")
    .filter(({ text }) => /\.from\(\s*["']outstation_expense_requests["']\s*\)[^;]*?\.delete\(/.test(code(text)))
    .map(({ file }) => file);
  assert.deepEqual(deleters, [], "no code may delete a request row directly: the trigger refuses it");
  const cleanups = filesUnder("scripts")
    .filter(({ text }) => /safeDelete\(\s*["']outstation_expense_requests["']/.test(code(text)))
    .map(({ file }) => file);
  assert.deepEqual(cleanups, [], "a fixture script may not delete its requests: that is an automatic delete");
  const doorCallers = filesUnder("src", "app", "scripts")
    .filter(({ text }) => code(text).includes("phx_owner_delete_outstation_request"))
    .map(({ file }) => file);
  assert.deepEqual(doorCallers, ["src/lib/outstation/service.ts"], "only the owner's delete may call the door");

  // 3. His button and the two routes stay.
  const admin = code(source("src/components/outstation/outstation-requests-admin.tsx"));
  assert.match(admin, /Delete expense/, "the owner keeps his Delete expense button");
  for (const route of ["app/api/admin/outstation/[id]/route.ts", "app/api/admin/outstation/manager-expenses/[id]/route.ts"]) {
    assert.match(code(source(route)), /await deleteOutstationRequestAsAdmin\(id, access\)/, `${route}: DELETE must reach the owner's delete`);
  }

  // 4. The database lets only the door through.
  const migrationName = fs
    .readdirSync(path.join(process.cwd(), "supabase/migrations"))
    .find((name) => name.endsWith("_outstation_request_delete_owner_only.sql"));
  assert.ok(migrationName, "the owner-only migration must exist");
  const sql = source(`supabase/migrations/${migrationName}`).replace(/--.*$/gm, "");
  assert.match(
    sql,
    /if tg_op = 'DELETE' and coalesce\(current_setting\('phx\.owner_request_delete', true\), ''\) = 'on' then\s+return old;\s+end if;\s+raise exception/,
    "the trigger must let a DELETE through only when the door opened it, and refuse everything else (a TRUNCATE included)",
  );
  assert.match(
    sql,
    /perform set_config\('phx\.owner_request_delete', 'on', true\);\s+delete from public\.outstation_expense_requests where id = p_request_id;[\s\S]*perform set_config\('phx\.owner_request_delete', '', true\);/,
    "the door must open for its own one-row delete and close again",
  );
  assert.match(sql, /revoke execute on function public\.phx_owner_delete_outstation_request\(bigint\) from public, anon, authenticated;/, "the door must be closed to browser roles");
  const firstSql = source(
    `supabase/migrations/${fs.readdirSync(path.join(process.cwd(), "supabase/migrations")).find((name) => name.endsWith("_outstation_requests_never_deleted.sql"))}`,
  ).replace(/--.*$/gm, "");
  assert.match(firstSql, /before truncate on public\.outstation_expense_requests/, "the TRUNCATE trigger from the first migration must stay");
  assert.match(firstSql, /before delete on public\.outstation_expense_requests\s+for each row/, "the DELETE trigger from the first migration must stay");

  // 5. The requests deleted before the rule still say so.
  assert.match(service, /\.like\("summary", "Admin deleted outstation request%"\)/, "the old deletions keep their notice");
}
