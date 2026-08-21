import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** The body of a top-level function, up to the next top-level function declaration. */
function functionBody(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const declaration = /^(export )?(async )?function [A-Za-z0-9_]+/;
  const start = lines.findIndex((line) => new RegExp(`^(export )?(async )?function ${name}\\b`).test(line));
  assert.notEqual(start, -1, `${name} must exist in the vacation service`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (declaration.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function runVacationRetentionPurgeAuditTests() {
  const service = readSource("../src/lib/vacation/service.ts");
  const audit = readSource("../src/lib/admin/audit.ts");

  // The purge is the one irreversible thing the leave module does: it deletes v2_vacation_requests
  // rows outright. Before 2026-08-21 it recorded only COUNTS, in a table whose writer swallowed a
  // missing-schema error — so a purge could destroy a year of leave history and leave nothing that
  // said whose. It had never run in production (0 rows in v2_vacation_retention_purge_runs), which
  // is the only reason this was latent rather than an incident.
  assert.ok(
    audit.includes('| "vacation_retention_purge"'),
    "AuditEntityType must carry vacation_retention_purge, or the purge audit row cannot be typed",
  );

  const purge = functionBody(service, "runVacationRetentionPurge");

  assert.ok(
    purge.includes("await writeRequiredAuditLog({"),
    "runVacationRetentionPurge must write a required audit row — deleting leave history must name its actor",
  );
  assert.ok(
    purge.includes('entityType: "vacation_retention_purge"'),
    "the purge audit row must be recorded against entityType vacation_retention_purge",
  );

  // Ordering is the whole point and nothing else enforces it: once the rows are deleted there is
  // nothing left to describe, so a manifest read placed after the delete would always be empty.
  const manifestAt = purge.indexOf("await fetchRequestHistoryPurgeManifest(");
  const firstDeleteAt = purge.indexOf(".delete({ count:");
  assert.notEqual(manifestAt, -1, "runVacationRetentionPurge must capture a manifest of what it is about to delete");
  assert.notEqual(firstDeleteAt, -1, "runVacationRetentionPurge must still perform its deletes");
  assert.ok(
    manifestAt < firstDeleteAt,
    "the purge manifest must be captured BEFORE the first delete runs",
  );

  // A dry run destroys nothing; it must not manufacture an audit row that says it did.
  assert.match(
    purge,
    /if \(!dryRun\) \{\s*\n\s*await writeRequiredAuditLog\(\{/,
    "the purge audit row must be written only for a real purge, never for a dry run",
  );

  // Owner's standing rule: never silently drop rows — count and flag instead.
  const manifestPayload = functionBody(service, "buildPurgeManifestPayload");
  for (const field of ["targetedRequestIds", "detailTruncated", "detailOmitted", "totalTargetedRequests"]) {
    assert.ok(
      manifestPayload.includes(`${field}:`),
      `the purge manifest must report ${field} so a large purge is flagged, never silently truncated`,
    );
  }

  // The request delete runs last, so a failure earlier in the sequence leaves the targeted rows
  // standing. The manifest must not claim they were purged — deletedCounts says who actually died.
  assert.ok(
    !/purgedRequest/.test(manifestPayload),
    "the manifest lists what the purge TARGETED; calling it 'purged' overstates a partially failed run",
  );

  // The run-table writer used to return silently when the table was missing, which is exactly how
  // a purge could end up recorded nowhere at all.
  const recordRun = functionBody(service, "recordRetentionPurgeRun");
  assert.ok(
    recordRun.includes("logError("),
    "recordRetentionPurgeRun must log loudly when the run table is missing instead of returning silently",
  );
  assert.ok(
    recordRun.includes("vacation_retention_purge_run_unrecorded"),
    "the missing-run-table failure must carry a searchable event label",
  );
}
