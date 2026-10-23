import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { _resetSharedReadCache, getOrLoadShared } from "../src/lib/cache/shared-read.ts";
import {
  REFERENCE_AREAS,
  REFERENCE_AREA_COLUMNS,
  REFERENCE_DEPARTMENTS,
  REFERENCE_DEPARTMENT_COLUMNS,
  REFERENCE_EMPLOYEES,
  REFERENCE_EMPLOYEE_COLUMNS,
  REFERENCE_LINES,
  REFERENCE_LINE_COLUMNS,
  forgetReferenceAreas,
  forgetReferenceDepartments,
  forgetReferenceEmployees,
  forgetReferenceLines,
} from "../src/lib/reference/reference-lists.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR REFERENCE LISTS ARE READ ONCE A MINUTE PER PROCESS — AND NOT BY EVERYONE (2026-10-23).
//
// `employees`, `lines`, `areas` and `departments` were measured at about 55,000 Supabase calls and
// 18,900 API-seconds a day, `employees` alone at 39,349 calls averaging 229 ms, while Postgres sat at
// 9.9% of one core. They are also the four smallest and least volatile tables in the system (220 /
// 4 / 143 / 11 rows on production that day), so every FULL-LIST read of them now goes through
// `src/lib/reference/reference-lists.ts` on the freshness the owner chose on 2026-10-16: a copy up to
// one minute old, dropped at once by a write this process makes.
//
// Three things are pinned here, because each of them is how this change could silently go wrong:
//
//  (1) THE COLUMNS. The employee superset carries no money column at all. A read that decides a
//      payment cannot be answered a minute late, so it is not answerable from here — and the way that
//      promise rots is somebody adding `base_salary` to the superset because one screen wanted it.
//  (2) WHO READS IT. The exact adopter list, and the proof that no excluded domain imports the
//      module: payroll, automated payroll, deductions and daily deductions, attendance,
//      notifications, approvals, marketing requests, sales and closing, direct orders, auth, and the
//      employee importer's own reads. The cache's contract (`src/lib/cache/shared-read.ts`) is that a
//      read deciding money, a deduction, an approval or a notification never comes through it.
//  (3) THE NAMESPACES. One per table, so an employee upsert drops the employee list and NOT the
//      four-row line list — which would be the opposite of the point.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODULE_PATH = "src/lib/reference/reference-lists.ts";
const MODULE_SPECIFIER = "@/lib/reference/reference-lists";
const LIMITS = { maxEntries: 2, maxRowsTotal: 100 };

/** Every file that may import the module, and which half of it each one uses. */
const ADOPTERS: ReadonlyArray<{ file: string; what: string }> = [
  { file: "src/lib/business-review/sources/field-link.ts", what: "lines and areas, for the field link's name maps" },
  { file: "src/lib/business-review/sources/roles.ts", what: "the review directory and the line id by code" },
  { file: "src/lib/crm/contact-trade.ts", what: "areas, for the trade badge's area code" },
  { file: "src/lib/crm/master.ts", what: "lines, for the master table's Line filter" },
  { file: "src/lib/customer-360/server/sources.ts", what: "lines, for the reps behind a hub's visits" },
  { file: "src/lib/customer-360/service.ts", what: "areas, lines and employees, for the page's name maps" },
  { file: "src/lib/hiring-pack/field-fill-rate.ts", what: "departments, for the fill-rate report" },
  { file: "src/lib/hiring-pack/service.ts", what: "lines, for the facts editor's picker" },
  { file: "src/lib/outstation/area-rep-options.ts", what: "employees, for the rep names on the wizard" },
  { file: "src/lib/probation/intelligence/manual-dv-day.ts", what: "lines, for the scorecard's line name" },
  { file: "src/lib/recruitment/manager-cv-engagement.ts", what: "lines, for each manager's product line" },
  // The two write paths below import the `forgetReference*` half only — they refresh the copy, they
  // never read through it. Block (4) proves that is all they take.
  { file: "src/lib/employees/employee-directory.ts", what: "the employee bump, on every directory invalidation" },
  { file: "app/api/imports/employees/confirm/route.ts", what: "the department and line bumps, as the importer writes them" },
];

/**
 * A domain whose reads decide money, a deduction, an approval, a notification or who may sign in.
 * None of these may import the module at all — not even the `forgetReference*` half, because a
 * module that has the import has the loaders one keystroke away.
 */
const EXCLUDED_DOMAINS: ReadonlyArray<{ dir: string; why: string }> = [
  { dir: "src/lib/payroll", why: "payroll decides a payment" },
  { dir: "src/lib/automated-payroll", why: "automated payroll decides a payment" },
  { dir: "src/lib/deductions", why: "a deduction is money off a salary" },
  { dir: "src/lib/daily-deductions", why: "a daily deduction is money off a salary" },
  { dir: "src/lib/attendance", why: "attendance feeds the deductions" },
  { dir: "src/lib/notifications", why: "a notification's recipients must be current" },
  { dir: "src/lib/approvals", why: "an approval route must read the live chain" },
  { dir: "src/lib/approvals-hub", why: "an approval route must read the live chain" },
  { dir: "src/lib/marketing-requests", why: "a marketing request is approved and paid" },
  { dir: "src/lib/sales", why: "the closing is the one source of truth for sales and targets" },
  { dir: "src/lib/direct-orders", why: "a direct order is money" },
  { dir: "src/lib/imports", why: "the employee importer reads back what it has just written" },
  { dir: "src/lib/auth", why: "who may sign in is never a minute old" },
];

/** Money columns on `employees` — none of them may appear in the superset select. */
const MONEY_COLUMNS = [
  "base_salary",
  "basic_salary",
  "gross_salary",
  "net_salary",
  "social_insurance_wage",
  "payment_mode",
  "payroll_eligible",
  "bank_account",
  "iban",
  "salary",
  "allowance",
  "incentive",
  "bonus",
  "deduction",
];

function code(path: string): string {
  return stripComments(readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n"));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every `.ts`/`.tsx` file under `src/` and `app/` that names the module. */
function importersOfTheModule(): string[] {
  const out: string[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("app")]) {
    if (file === MODULE_PATH) continue;
    if (code(file).includes(MODULE_SPECIFIER)) out.push(file);
  }
  return out.sort();
}

export async function runReferenceListCacheTests() {
  // ── (1) The employee superset names identity and placement, never money ──────
  {
    const columns = REFERENCE_EMPLOYEE_COLUMNS.split(",").map((column) => column.trim());
    assert.ok(columns.length > 10, "RED the employee superset is the one select every adopter shares");
    assert.equal(columns[0], "hr_id", "RED `hr_id` is the primary key and so the keyset cursor");
    assert.equal(new Set(columns).size, columns.length, "RED a column is named twice in the superset");

    for (const money of MONEY_COLUMNS) {
      assert.ok(
        !columns.some((column) => column === money || column.includes(money)),
        `RED the reference employee superset must never name \`${money}\` — a column that decides a payment cannot be read a minute late`,
      );
    }

    // The three org selects, whole, so adding a column to one of them is a deliberate act that
    // starts by checking the column exists on production (PostgREST fails the WHOLE read otherwise).
    assert.equal(REFERENCE_LINE_COLUMNS, "id,code,name,department_id,is_active,updated_at");
    assert.equal(REFERENCE_AREA_COLUMNS, "id,code,name,line_id,is_active,updated_at");
    assert.equal(REFERENCE_DEPARTMENT_COLUMNS, "id,code,name,is_active,updated_at");

    // Every select is keyset-paged on the table's own primary key, and nothing caps the rows.
    const moduleSource = code(MODULE_PATH);
    assert.match(moduleSource, /fetchAllRowsKeyset<Row>/, "RED every list is read with the keyset pager, never an unbounded select");
    assert.ok(!/\.limit\(/.test(moduleSource), "RED a reference list is never capped — a short list reads as a fact about the company");
    assert.ok(!/\.range\(/.test(moduleSource), "RED an offset walk can shift a page under a concurrent write");
  }

  // ── (2) Exactly these files read the lists, and no excluded domain does ──────
  {
    const found = importersOfTheModule();
    const expected = ADOPTERS.map((adopter) => adopter.file).sort();
    assert.deepEqual(
      found,
      expected,
      "RED the reference-list adopter list changed. Add the new file to ADOPTERS above with what it reads — " +
        "and if it is a read that decides money, a deduction, an approval or a notification, it may not come through here at all",
    );

    for (const { dir, why } of EXCLUDED_DOMAINS) {
      for (const file of sourceFiles(dir)) {
        assert.ok(
          !code(file).includes(MODULE_SPECIFIER),
          `RED ${file} must not import the reference lists — ${why}`,
        );
      }
    }

    // The exclusion is stated in the module's own docblock too, so the reason survives next to the code.
    const raw = readFileSync(join(ROOT, MODULE_PATH), "utf8");
    for (const word of ["payroll", "deductions", "attendance", "notifications", "approvals", "direct orders"]) {
      assert.ok(raw.includes(word), `RED the module's docblock must say that ${word} keeps its own fresh reads`);
    }
  }

  // ── (3) One namespace per table: a bump drops its own list and no other ──────
  // The loaders themselves need the service-role client, so the namespaces are exercised through
  // `getOrLoadShared` directly — the same call each loader makes, with the same namespace constant.
  {
    _resetSharedReadCache();
    const namespaces = [REFERENCE_EMPLOYEES, REFERENCE_LINES, REFERENCE_AREAS, REFERENCE_DEPARTMENTS];
    assert.equal(new Set(namespaces).size, 4, "RED a shared namespace would make one write drop another list");

    const loads = new Map<string, number>(namespaces.map((name) => [name, 0]));
    const read = async (name: string) => {
      const result = await getOrLoadShared<{ id: number }>(
        name,
        "list",
        async () => {
          loads.set(name, (loads.get(name) ?? 0) + 1);
          return [{ id: 1 }];
        },
        LIMITS,
      );
      return result.cache;
    };

    for (const name of namespaces) assert.equal(await read(name), "miss");
    for (const name of namespaces) assert.equal(await read(name), "hit", `RED the second read of ${name} must be served from the copy`);

    const bumps: ReadonlyArray<[string, (reason: string) => void]> = [
      [REFERENCE_EMPLOYEES, forgetReferenceEmployees],
      [REFERENCE_LINES, forgetReferenceLines],
      [REFERENCE_AREAS, forgetReferenceAreas],
      [REFERENCE_DEPARTMENTS, forgetReferenceDepartments],
    ];
    for (const [bumped, forget] of bumps) {
      forget("test");
      for (const name of namespaces) {
        const expectation = name === bumped ? "miss" : "hit";
        assert.equal(
          await read(name),
          expectation,
          `RED forgetting ${bumped} must drop ${bumped} and leave ${name} alone`,
        );
      }
    }

    assert.deepEqual(
      namespaces.map((name) => loads.get(name)),
      [2, 2, 2, 2],
      "RED each list was loaded once at the start and once more by its own bump — four bumps, four reloads",
    );
  }

  // ── (4) The app's own writes refresh the copy, in the same place they invalidate everything else ──
  {
    const directory = code("src/lib/employees/employee-directory.ts");
    const declaration = "export function invalidateEmployeeDirectoryCache()";
    const start = directory.indexOf(declaration);
    assert.ok(start >= 0, `RED ${declaration} is the one call every employee writer already makes`);
    const body = directory.slice(start, directory.indexOf("\n}", start));
    assert.match(
      body,
      /forgetReferenceEmployees\(/,
      "RED every employee write already calls invalidateEmployeeDirectoryCache — the reference bump belongs INSIDE it, not in a second call each writer has to remember",
    );
    assert.ok(
      !/loadReference(Employees|Lines|Areas|Departments)\(/.test(directory),
      "RED the directory is the fresh read the bump protects; it must not read through the copy itself",
    );

    // The importer writes departments, then lines, then employees, and reads them back inside the
    // SAME request to resolve what it has just created — so these two bumps are correctness, not polish.
    const importer = code("app/api/imports/employees/confirm/route.ts");
    assert.match(importer, /forgetReferenceDepartments\(/, "RED the importer's department upsert must drop the department copy");
    assert.match(importer, /forgetReferenceLines\(/, "RED the importer's line upsert must drop the line copy");
    assert.ok(
      !/loadReference(Employees|Lines|Areas|Departments)\(/.test(importer),
      "RED the employee importer reads back what it has just written; it reads live, never through the copy",
    );

    // Nothing writes `areas` anywhere in `src/` or `app/`, which is why there is no area bump to place.
    const writers = [...sourceFiles("src"), ...sourceFiles("app")].filter((file) =>
      /from\("areas"\)\s*\n?\s*\.(insert|update|upsert|delete)|\.from\("areas"\)\.(insert|update|upsert|delete)/.test(code(file)),
    );
    assert.deepEqual(
      writers,
      [],
      "RED something now writes `areas` — call forgetReferenceAreas() there, the way the importer does for lines and departments",
    );
  }

  console.log("reference list cache: 4 blocks passed");
}
