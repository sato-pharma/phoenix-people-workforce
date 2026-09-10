import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { contextVariables, interpolate } from "../src/lib/email-templates/render-core.ts";

const migrationSource = readFileSync(
  new URL("../supabase/migrations/20260910223000_leave_request_codes.sql", import.meta.url),
  "utf8",
);
const excuseServiceSource = readFileSync(
  new URL("../src/lib/excuses/service.ts", import.meta.url),
  "utf8",
);
const vacationServiceSource = readFileSync(
  new URL("../src/lib/vacation/service.ts", import.meta.url),
  "utf8",
);
const vacationTypesSource = readFileSync(
  new URL("../src/lib/vacation/types.ts", import.meta.url),
  "utf8",
);
const vacationEmailSource = readFileSync(
  new URL("../src/lib/vacation/email.ts", import.meta.url),
  "utf8",
);
const emailTemplatesSource = readFileSync(
  new URL("../src/lib/email-templates/service.ts", import.meta.url),
  "utf8",
);
const tokenRegistrySource = readFileSync(
  new URL("../src/lib/email-templates/token-registry.ts", import.meta.url),
  "utf8",
);
const templateManagerSource = readFileSync(
  new URL("../src/components/admin/email-template-manager.tsx", import.meta.url),
  "utf8",
);
const vacationCalculationsSource = readFileSync(
  new URL("../src/lib/vacation/calculations.ts", import.meta.url),
  "utf8",
);

function has(source: string, needle: string, why: string) {
  assert.ok(source.includes(needle), `${why} — expected to find: ${needle}`);
}

function lacks(source: string, needle: string, why: string) {
  assert.ok(!source.includes(needle), `${why} — expected NOT to find: ${needle}`);
}

/**
 * Owner request, 2026-09-10: every excuse and every vacation, historical and upcoming, carries a
 * unique code a human can read out. These pin the properties that make it an identifier rather
 * than a decoration.
 *
 * Assertions are substring checks on purpose. The earlier draft used regexes and the escaping
 * silently collapsed a character class into something that matched nothing, which is the failure
 * mode a pinning test can least afford.
 */
export function runLeaveRequestCodesTests() {
  for (const [table, prefix, sequence] of [
    ["v2_excuse_requests", "EXC", "v2_excuse_request_code_seq"],
    ["v2_vacation_requests", "VAC", "v2_vacation_request_code_seq"],
  ] as const) {
    // The code is assigned by the DATABASE, not by a service. A code minted in TypeScript is a code
    // that a direct SQL insert, a backfill or a future writer can forget to mint.
    has(
      migrationSource,
      `set default '${prefix}-' || lpad(nextval('public.${sequence}')::text, 4, '0');`,
      `${table}.request_code must carry a sequence-backed column default, so no insert path can produce a row without a code`,
    );

    // A sequence, never max()+1 or count(): those renumber after a delete and race on concurrent inserts.
    has(
      migrationSource,
      `create sequence if not exists public.${sequence}`,
      `${table} must draw its number from a real sequence`,
    );

    has(
      migrationSource,
      `on public.${table} (request_code);`,
      `${table}.request_code must be unique, or it identifies nothing`,
    );

    // NOT NULL is also what proves the historical backfill ran: the statement cannot succeed while
    // a single row is missing a code.
    has(
      migrationSource,
      `alter table public.${table}
  alter column request_code set not null;`,
      `${table}.request_code must be NOT NULL`,
    );

    // The owner asked for historical requests to carry a code too, not just new ones.
    has(
      migrationSource,
      `set request_code = '${prefix}-' || lpad(ordered.rn::text, 4, '0')`,
      `${table} must backfill every existing row`,
    );

    // Once assigned the code does not move: every screen, email and printout that quoted it would
    // otherwise point at nothing.
    has(
      migrationSource,
      `create trigger ${table}_freeze_request_code`,
      `${table} needs the freeze trigger wired, not merely the function defined`,
    );
    has(
      migrationSource,
      `before update on public.${table}`,
      `${table}'s freeze trigger must fire before update`,
    );
  }

  // The backfill orders by created_at with id as the tiebreaker. Without it, two rows written in
  // the same microsecond have no defined order and a re-run could number them differently.
  has(
    migrationSource,
    "row_number() over (order by created_at, id) as rn",
    "backfill order must be deterministic",
  );

  has(
    migrationSource,
    "request_code is immutable",
    "an update that changes request_code must be refused at the database, not merely avoided by convention",
  );

  // Every excuse read must carry the column. The list used to be repeated verbatim at eight call
  // sites, which is how a column reaches most screens and is quietly undefined on one.
  has(
    excuseServiceSource,
    '"id,request_code,employee_hr_id',
    "the excuse read column list must include request_code",
  );
  has(
    excuseServiceSource,
    "const excuseColumnsWithEmail =",
    "the excuse read used for email sends must go through a shared column constant too",
  );
  lacks(
    excuseServiceSource,
    '.select("id,employee_hr_id',
    "excuse reads must go through the shared column constants, or a new column reaches only some of them",
  );
  has(
    excuseServiceSource,
    "requestCode: row.request_code,",
    "the excuse mapper must expose the stored code to every caller",
  );

  has(
    vacationServiceSource,
    "requestCode: text(row.request_code),",
    "the vacation mapper must expose the stored code to every caller",
  );
  has(
    vacationTypesSource,
    "  requestCode: string;",
    "requestCode is required on VacationRequestRecord, so a screen cannot silently render undefined",
  );

  // The retired generator hashed the uuid into VR-100..VR-999 — 900 possible values. Against the
  // 547 live vacation requests it produced only 414 distinct ids: 239 rows shared an id with
  // another request and one id was worn by four. Reintroducing it re-breaks what this change fixes.
  lacks(
    vacationCalculationsSource,
    "vacationRequestDisplayId",
    "the uuid-derived VR- display id must stay retired: it collapsed 547 vacations onto 414 values",
  );

  // ── The code has to reach the emails, which is where a manager decides ──

  // A context key absent from TOKEN_REGISTRY is silently dropped by contextVariables, so the
  // token would render as an empty string with nothing to show it happened.
  has(tokenRegistrySource, "token: BQUOTErequestCodeBQUOTE".split("BQUOTE").join(String.fromCharCode(34)),
    "requestCode must be a registered token or every {{requestCode}} renders blank");
  has(templateManagerSource, "token: BQUOTErequestCodeBQUOTE".split("BQUOTE").join(String.fromCharCode(34)),
    "the template editor carries its own copy of the token list; a token missing there cannot be inserted by whoever edits a template");

  // Functional, not a source assertion: render it and read the output back.
  const vars = contextVariables({ requestCode: "VAC-0042" }, "Team");
  assert.equal(vars.requestCode, "VAC-0042", "contextVariables must resolve requestCode to its value");
  const rendered = interpolate("code {{requestCode}}", vars, true);
  assert.equal(rendered, "code VAC-0042", "the rendered email body must carry the code, not the token");

  // Every approval email passes it. The vacation templates render {{detailsTable}}, so the row
  // is what surfaces there; the excuse ones use metrics.
  const rowCount = vacationEmailSource.split("{ label: BQUOTERequest codeBQUOTE, value: input.request.requestCode }".split("BQUOTE").join(String.fromCharCode(34))).length - 1;
  assert.equal(rowCount, 3, "all three vacation approval emails (request, decision, manager step) must carry the code row");
  const metricCount = excuseServiceSource.split("label: BQUOTERequest codeBQUOTE".split("BQUOTE").join(String.fromCharCode(34))).length - 1;
  assert.equal(metricCount, 2, "both excuse emails (manager request, employee decision) must carry the code metric");

  // These two bodies render a fixed field list rather than {{detailsTable}}, so a metric row
  // cannot reach them and the token must be written into the body itself.
  has(emailTemplatesSource, "<strong>Request code:</strong> {{requestCode}}",
    "the excuse_decision and leave_returned bodies must name the code explicitly");

  // The rejection email used to hand the employee the raw uuid as the request identity.
  lacks(vacationEmailSource, "input.request.id ?? " + String.fromCharCode(34) + String.fromCharCode(8212) + String.fromCharCode(34),
    "the rejection email must identify the request by its code, never by the uuid");
}
