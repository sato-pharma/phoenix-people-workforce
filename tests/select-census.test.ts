// SELECT CENSUS — scripts/select-census.mjs, the deterministic half of the select-auditor subagent.
//
// On 2026-09-29 a column was dropped on the strength of a grep and a select that still named it took
// the organogram down; the grep missed it because the select was a CONSTANT, and a `[^)]*` match
// would also have cut any select at its first embedded relation. This pins the census against both,
// on a scratch repo, and against the real tree: every `.from("employees")` a raw count finds, the
// census must find too — a census that silently misses sites is a grep with extra steps.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { blankComments, censusOfFile, parseSelect, runCensus, sitesNaming } from "../scripts/select-census.mjs";

function write(root: string, rel: string, body: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

/** A census call site. `scripts/select-census.mjs` is untyped JS, so this is the shape it builds. */
type CensusEmbed = { relation: string; hint: string | null; columns: string[]; embeds: CensusEmbed[]; star: boolean };
type CensusSite = {
  file: string;
  line: number;
  kind: string;
  select: string | null;
  resolved: boolean;
  note: string;
  columns: string[];
  embeds: CensusEmbed[];
  star: boolean;
  filters: string[];
  writeKeys: string[];
};
const sitesOf = (census: { sites: unknown[] }): CensusSite[] => census.sites as CensusSite[];

export function runSelectCensusTests() {
  // 1. The select grammar.
  assert.deepEqual(
    parseSelect("hr_id, lines(name), full_name"),
    { columns: ["hr_id", "full_name"], embeds: [{ relation: "lines", hint: null, columns: ["name"], embeds: [], star: false }], star: false },
    "a column AFTER an embedded relation must survive — a [^)]* match drops it",
  );
  assert.deepEqual(
    parseSelect("name:full_name, salary:base_salary::text, meta->>x, count()").columns,
    ["full_name", "base_salary", "meta"],
    "aliases, casts and JSON paths reduce to the real column; count() is not a column",
  );
  const embedded = parseSelect("id, manager:employees!manager_hr_id(full_name), ...teams!inner(name)");
  assert.deepEqual(embedded.embeds.map((e: { relation: string; hint: string | null }) => [e.relation, e.hint]), [["employees", "manager_hr_id"], ["teams", "inner"]]);
  assert.equal(parseSelect("*").star, true);

  // 2. The census, on a scratch repo.
  const root = mkdtempSync(join(tmpdir(), "phx-census-"));
  try {
    write(root, "src/lib/cols.ts", 'export const EMP = ["hr_id", "team_id"].join(",");\n');
    write(
      root,
      "src/lib/a.ts",
      [
        'import { EMP } from "@/lib/cols";',
        'const COLS = "hr_id, work_email";',
        'export const literal = () => db.from("employees").select("hr_id, lines(name), full_name");',
        "export const viaConst = () => db.from(\"employees\").select(COLS).eq(\"line_id\", 1).order(\"hire_date\");",
        "export const viaImport = () => db.from(\"employees\").select(EMP);",
        "export const viaTemplate = () => db.from(\"employees\").select(`${COLS}, area_id`).or(\"exit_status.is.null,employment_status.eq.active\");",
        "export const write = () => db.from(\"employees\").update({ job_title: t, updated_at: now }).eq(\"hr_id\", id);",
        'export const dynamic = () => db.from("employees").select(columns.join(","));',
        'export const otherTable = () => db.from("employees_archive").select("nope");',
        'export const otherSchema = () => db.schema("au").from("employees").select("seat_code");',
        "",
      ].join("\n"),
    );
    const census = runCensus({ table: "employees", root });
    const byLine = (n: number) => sitesOf(census).find((s) => s.line === n)!;
    assert.equal(census.sites.length, 6, "exactly the six public.employees sites — not employees_archive, not the au schema");

    assert.deepEqual(byLine(3).columns, ["hr_id", "full_name"]);
    assert.deepEqual(byLine(4).columns, ["hr_id", "work_email"], "a same-file constant select must be resolved");
    assert.deepEqual(byLine(4).filters, ["line_id", "hire_date"]);
    assert.deepEqual(byLine(5).columns, ["hr_id", "team_id"], "an imported constant select must be resolved one import away");
    assert.deepEqual(byLine(6).columns, ["hr_id", "work_email", "area_id"], "a template with ${CONST} must be resolved");
    assert.deepEqual(byLine(6).filters, ["exit_status", "employment_status"], "an .or() filter names columns too");
    assert.equal(byLine(7).kind, "write");
    assert.deepEqual(byLine(7).writeKeys, ["job_title", "updated_at"]);
    assert.equal(byLine(8).resolved, false, "a select built at run time must be UNRESOLVED, never read as clean");

    assert.deepEqual(
      (sitesNaming(census, "hire_date") as CensusSite[]).map((s) => s.line),
      [4],
      "--column finds a column named only in a filter",
    );

    // ── THE THREE WAYS IT CRIED WOLF ON ITS FIRST REAL AUDIT (2026-09-30) ──────────────────────
    // Each of these reported a column that does not exist on the base table, i.e. a false 42703 on
    // a read that is correct and live. A census that invents findings is worse than none: it gets
    // switched off, and the real one (v2_vacation_requests.type) goes down with it.
    write(
      root,
      "src/lib/b.ts",
      [
        // 1. An order on an EMBEDDED table. `year`/`month` are salary_batches', not salary_records'.
        'export const embedOrder = () => db.from("salary_records").select("*, salary_batches!inner(year, month, status)")',
        '  .in("salary_batches.status", ["approved"])',
        '  .order("year", { foreignTable: "salary_batches", ascending: false })',
        '  .order("created_at", { ascending: false });',
        // 2. A delete's OPTIONS object is not a payload: `count` is not a column.
        'export const del = () => db.from("salary_records").delete({ count: "exact" }).eq("batch_id", id);',
        // 3. An apostrophe in a COMMENT used to open a string that swallowed the statement end, so
        //    the scan ran on into the next one and reported ITS filter as this table's column.
        'export const commented = () => db.from("salary_records")',
        '  // the column\'s fail-closed default is what this read relies on',
        '  .select("hr_id")',
        '  .eq("hr_id", id);',
        'export const nextStatement = () => db.from("salary_batches").delete().eq("phantom_column", 1);',
        "",
      ].join("\n"),
    );
    const sr = runCensus({ table: "salary_records", root });
    const all = (key: "columns" | "filters" | "writeKeys") => sitesOf(sr).flatMap((s) => s[key]);
    assert.deepEqual(
      sitesOf(sr).find((s) => s.line === 1)!.embeds,
      [{ relation: "salary_batches", hint: "inner", columns: ["year", "month", "status"], embeds: [], star: false }],
      "an order with foreignTable, and a dotted filter, belong to the EMBEDDED table",
    );
    for (const ghost of ["year", "month", "status"]) {
      assert.ok(!all("filters").includes(ghost), `"${ghost}" is salary_batches', never salary_records' — it must not be a base-table filter`);
    }
    assert.ok(!all("writeKeys").includes("count"), "`.delete({ count: \"exact\" })` passes options, not columns");
    assert.ok(
      !all("filters").includes("phantom_column"),
      "an apostrophe in a comment must not let the scan run into the NEXT statement and claim its filter",
    );

    // A chain longer than the cap is UNRESOLVED, never half-read: reading further picks up the
    // next statement's columns, which is exactly the false finding above.
    write(
      root,
      "src/lib/c.ts",
      `export const huge = () => db.from("employees").insert({ pad: "${"x".repeat(21000)}" });\n` +
        'export const after = () => db.from("employees").delete().eq("phantom_column", 1);\n',
    );
    const huge = sitesOf(runCensus({ table: "employees", root })).find((s) => s.file.endsWith("c.ts"))!;
    assert.equal(huge.resolved, false, "a chain past the cap must be UNRESOLVED");
    assert.match(huge.note, /runs past/, huge.note);
    assert.ok(!huge.filters.includes("phantom_column"), "a truncated chain must not claim the next statement's filter");
    assert.equal(runCensus({ table: "employees", schema: "au", root }).sites.length, 1, "--schema au reads only the au chain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 3. The real tree: the census finds every site a raw count does.
  const real = runCensus({ table: "employees", root: resolve(".") });
  assert.ok(real.filesScanned > 2000, `the census must reach src/ and app/ — it scanned ${real.filesScanned} files`);
  let raw = 0;
  const stack = [resolve("src"), resolve("app")];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "node_modules" && name !== ".next") stack.push(p);
      } else if (/\.(tsx?|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) {
        raw += (readFileSync(p, "utf8").match(/\.from\(\s*["'`]employees["'`]\s*\)/g) ?? []).length;
      }
    }
  }
  const schemaFiltered = real.sites.length;
  assert.ok(raw > 100, `expected the real employees reads, found ${raw}`);
  assert.ok(
    schemaFiltered <= raw && raw - schemaFiltered <= 5,
    `the census found ${schemaFiltered} public.employees sites where a raw count finds ${raw} — it is missing reads`,
  );
  // A ratchet, not a truth: UNRESOLVED means "not checked", so this number should FALL over time and
  // must never quietly climb. Measured 2026-09-30 on `employees`: 6 — one select built at run time
  // (`custom-variables.ts`) and five writes whose payload is not an object literal, which became
  // visible the day writes stopped being silently reported as clean.
  const unresolved = sitesOf(real).filter((s) => !s.resolved);
  assert.ok(unresolved.length <= 6, `too many unresolved employees selects (${unresolved.length}) — the resolver has regressed`);

  // 4. censusOfFile BLANKS COMMENTS ITSELF — it is exported, and a caller driving it directly gets
  // the same answer runCensus does. Found 2026-09-30 by the recruitment audit, which read each file
  // ONCE and asked every table about it (4,441 files × 50 tables is 222k reads otherwise), so it
  // called censusOfFile rather than runCensus and inherited raw source. One apostrophe inside a `//`
  // line opens a phantom string literal, the chain capture runs past the end of the statement, and
  // the NEXT query's filters land on this table — wrong in BOTH directions at once, which is what
  // this fixture reproduces: without the blanking the insert's own two columns VANISH and two
  // columns of a different table appear. The vanishing half is the dangerous one, because a column
  // the census never names is a column the probe never checks, so the audit reads clean.
  const commented = [
    'export async function createTemplate(db, input, ref) {',
    "  const { data } = await db",
    '    .from("offer_templates")',
    "    .insert({",
    "      name: input.name,",
    "      // Never on create. A new template is somebody's own design, not a built-in.",
    "      is_default: false,",
    "    })",
    '    .select("*")',
    "    .single();",
    '  const other = await db.from("offers").select("id").eq("reference", ref).order("created_at");',
    "  return [data, other];",
    "}",
  ].join("\n");
  const fromRaw = (censusOfFile("x/y.ts", commented, { table: "offer_templates", root: "x" }) as CensusSite[])[0];
  assert.deepEqual(
    fromRaw.writeKeys,
    ["name", "is_default"],
    "censusOfFile lost the insert's own columns to an apostrophe in a comment — it must blank comments itself",
  );
  assert.deepEqual(
    fromRaw.filters,
    [],
    `censusOfFile attributed another table's filters to this one (${fromRaw.filters.join(", ")}) — the chain ran past the statement`,
  );
  // And blanking twice changes nothing, so runCensus handing in pre-blanked source stays correct.
  const fromBlanked = (censusOfFile("x/y.ts", blankComments(commented), { table: "offer_templates", root: "x" }) as CensusSite[])[0];
  assert.deepEqual(fromBlanked.writeKeys, fromRaw.writeKeys, "blankComments must be idempotent");
  assert.deepEqual(fromBlanked.filters, fromRaw.filters, "blankComments must be idempotent");

  // 5. A WRITE IS NEVER "RESOLVED" WHILE ITS COLUMNS ARE UNREAD — the two ways that happened, both
  // found 2026-09-30 by the attendance audit. This is the worst failure mode this file has, worse
  // than refusing to answer: a site marked resolved is a site an audit counts as CHECKED, and a
  // column that is never NAMED is a column that is never PROBED. Measured across the 71 tables of
  // the recruitment and attendance audits: 12 sites of the first kind and 17 of the second, 28
  // distinct sites in all, every one of which those audits had reported as clean without looking.
  {
    // (a) A spread carries columns this cannot see. Keep the literal keys, but say so.
    const spread = [
      "async function save(db, row) {",
      '  await db.from("attendance_device_user_map").insert({',
      "    ...row,",
      "    created_at: now,",
      "  });",
      "}",
    ].join("\n");
    const site = (censusOfFile("x/y.ts", spread, { table: "attendance_device_user_map", root: "x" }) as CensusSite[])[0];
    assert.equal(
      site.resolved,
      false,
      "a write payload that spreads another object must be UNRESOLVED — it listed `created_at` alone " +
        "and called itself resolved, so six columns of `row` were never probed",
    );
    assert.match(site.note, /spreads another object/, "the note must say WHY it is unresolved");
    assert.deepEqual(site.writeKeys, ["created_at"], "the literal keys it COULD read are still worth reporting");
  }

  {
    // (b) A write carries two halves. The select's verdict must never overwrite the payload's.
    const both = [
      "async function save(db, payload) {",
      '  await db.from("deductions_decisions").insert(payload).select("id,candidate_id").single();',
      "}",
    ].join("\n");
    const site = (censusOfFile("x/y.ts", both, { table: "deductions_decisions", root: "x" }) as CensusSite[])[0];
    assert.equal(
      site.resolved,
      false,
      "an unreadable write payload must stay UNRESOLVED even when the .select() beside it resolves — " +
        "assigning the select's verdict over it reported `resolved: true` on a site whose own note " +
        "said its columns were NOT checked",
    );
    assert.match(
      site.note,
      /payload is not an object literal/,
      "the payload's note must survive — the select's note must not replace the reason the site is unreadable",
    );
  }
}
