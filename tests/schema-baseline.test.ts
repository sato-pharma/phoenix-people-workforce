import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  BASELINE_HEADER,
  BASELINE_SCHEMAS,
  PG_DUMP_ARGS,
  PG_DUMP_DOCKER_IMAGE,
  PG_DUMP_MAJOR,
  CLEAR_DEFAULT_PRIVILEGES,
  PRODUCTION_EXTENSIONS,
  RESTORE_PG_MAJOR,
  assertProductionUrl,
  assertScratchUrl,
  toPooler,
  compareDumps,
  explainDrift,
  freshnessQuery,
  normalizeDump,
  objectWord,
  restorableBaseline,
  restorePrelude,
  rolesNamedIn,
  splitObjects,
} from "../scripts/lib/schema-baseline.mjs";

/**
 * THE PRODUCTION SCHEMA BASELINE (enterprise audit 2026-11-13, REC-041 / F-DB-010, S03).
 *
 * Before it, nothing in the repository said what production's schema IS: 63 SQL files outside the
 * migration folder, a migration history that cannot rebuild production from nothing, and changes made
 * by hand that no file recorded. `supabase/schema/production.sql` is a schema-only pg_dump of
 * production, normalised so two dumps of an unchanged database are byte-identical, and the nightly
 * Migration Drift Check dumps production again and compares, object by object.
 *
 * This pins the parts that make that comparison honest:
 *   - normalisation strips exactly the run-to-run noise (pg_dump 18's random `\restrict` key, the
 *     version stamps, CRLF) and nothing else, so a real change can never normalise away;
 *   - an object is found by pg_dump's own table of contents, and a change in its body reads as changed;
 *   - drift a newer migration names is a warning; drift nothing names is red;
 *   - the committed file is normalised, LF, carries the header and holds no secret;
 *   - the nightly leg is wired: it runs, reds the verdict and has its own budget;
 *   - the weekly restore check (docs/security/schema-restore-check.md) creates what pg_dump never carries
 *     (the roles the file names, the extensions it uses, empty default privileges), refuses any target
 *     that is not a throwaway database on the runner, and runs at production's own Postgres major.
 */

const BASELINE = "supabase/schema/production.sql";
const WORKFLOW = ".github/workflows/migration-drift-check.yml";
const RESTORE_WORKFLOW = ".github/workflows/schema-restore-check.yml";

const PROD = "postgresql://postgres.ozucdzovmcqvepbozvqf:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";
const STAGING = "postgresql://postgres.cifwmndunmlxjhyjugxa:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";

const RAW = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "\\restrict AbC123randomKey",
  "",
  "-- Dumped from database version 17.6",
  "-- Dumped by pg_dump version 18.4",
  "",
  "",
  "",
  "--",
  "-- Name: employees; Type: TABLE; Schema: public; Owner: postgres",
  "--",
  "",
  "CREATE TABLE public.employees (",
  "    hr_id text NOT NULL",
  ");",
  "",
  "--",
  "-- Name: fx_rate(a integer); Type: FUNCTION; Schema: public; Owner: postgres",
  "--",
  "",
  "CREATE FUNCTION public.fx_rate(a integer) RETURNS integer LANGUAGE sql AS $$ select a $$;",
  "",
  "--",
  "-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres",
  "--",
  "",
  "ALTER TABLE ONLY public.employees ADD CONSTRAINT employees_pkey PRIMARY KEY (hr_id);",
  "",
  "\\unrestrict AbC123randomKey",
  "",
].join("\r\n");

export function runSchemaBaselineTests() {
  // ── normalisation: the noise goes, the schema stays ─────────────────────────────────────────────
  const normal = normalizeDump(RAW);
  assert.ok(normal.startsWith(BASELINE_HEADER), "the header says the file is generated and how to refresh it");
  assert.doesNotMatch(normal, /\r/, "CRLF from a Windows pg_dump is normalised to LF");
  assert.doesNotMatch(normal, /^\\(un)?restrict /m, "pg_dump 18's random \\restrict key is stripped — it differs every run");
  assert.doesNotMatch(normal, /^-- Dumped (from|by) /m, "the server and client version stamps are stripped");
  assert.doesNotMatch(normal, /\n{3,}/, "blank runs collapse");
  assert.match(normal, /CREATE TABLE public\.employees/, "the schema itself survives normalisation");
  assert.equal(normalizeDump(normal), normal, "normalising twice changes nothing");
  assert.equal(
    normalizeDump(RAW.replace(/AbC123randomKey/g, "ZzZ999otherKey").replace("17.6", "17.7")),
    normal,
    "two dumps of an unchanged database are byte-identical whatever key and version they carry",
  );
  assert.notEqual(
    normalizeDump(RAW.replace("hr_id text NOT NULL", "hr_id text")),
    normal,
    "a real change never normalises away",
  );

  // ── objects, by pg_dump's own table of contents ───────────────────────────────────────────────────
  const objects = splitObjects(normal);
  assert.deepEqual(
    [...objects.keys()].sort(),
    ["CONSTRAINT public.employees employees_pkey", "FUNCTION public.fx_rate(a integer)", "TABLE public.employees"],
    "each object is keyed TYPE schema.name from its TOC line",
  );
  assert.equal(objectWord("FUNCTION public.f(a integer)"), "f", "a function's word drops its argument list");
  assert.equal(objectWord("CONSTRAINT public.employees employees_pkey"), "employees_pkey", "a constraint's word drops its table");
  assert.equal(objectWord('TABLE public."Odd Name"'), "Name", "quotes are dropped");

  // ── comparison and explanation ────────────────────────────────────────────────────────────────────
  assert.deepEqual(compareDumps(normal, normal), { added: [], removed: [], changed: [], objects: 3 }, "a dump against itself is clean");

  const live = normalizeDump(
    RAW.replace("hr_id text NOT NULL", "hr_id text NOT NULL,\n    phone text").replace(
      "\\unrestrict",
      "--\n-- Name: grade_of(); Type: FUNCTION; Schema: public; Owner: postgres\n--\n\nCREATE FUNCTION public.grade_of() RETURNS void;\n\n\\unrestrict",
    ).replace(/--\r\n-- Name: fx_rate\(a integer\)[\s\S]*?\$\$;\r\n/, ""),
  );
  const diff = compareDumps(normal, live);
  assert.deepEqual(diff.added, ["FUNCTION public.grade_of()"], "a new object reads as added");
  assert.deepEqual(diff.removed, ["FUNCTION public.fx_rate(a integer)"], "a dropped object reads as removed");
  assert.deepEqual(diff.changed, ["TABLE public.employees"], "an object whose body moved reads as changed");

  const named = explainDrift(diff, ["alter table public.employees add column phone text;", "create function public.grade_of()", "drop function public.fx_rate(integer);"]);
  assert.deepEqual(named.unexplained, [], "drift a newer migration names is explained — the baseline is behind");
  const handMade = explainDrift(diff, ["alter table public.employees add column phone text;"]);
  assert.deepEqual(
    handMade.unexplained,
    ["FUNCTION public.grade_of()", "FUNCTION public.fx_rate(a integer)"],
    "drift no migration names is unexplained — a hand change, or an applied migration not on main",
  );
  assert.deepEqual(explainDrift({ added: ["FUNCTION public.f()"], removed: [], changed: [] }, ["create function public.f2()"]).unexplained,
    ["FUNCTION public.f()"], "a word of two letters or fewer never counts as named — it is in every file");

  // ── the URL must be production's ──────────────────────────────────────────────────────────────────
  assert.doesNotThrow(() => assertProductionUrl(PROD), "production's pooler URL is accepted");
  assert.throws(() => assertProductionUrl(STAGING), /does not name production/, "staging is refused — the baseline describes production only");
  assert.throws(() => assertProductionUrl(""), /no database URL/, "no URL is refused, never a silent pass");

  // ── IPv4: the runner cannot reach the direct host (IPv6 only) ─────────────────────────────────────
  assert.equal(
    toPooler("postgresql://postgres:p%40ss@db.ozucdzovmcqvepbozvqf.supabase.co:5432/postgres"),
    "postgresql://postgres.ozucdzovmcqvepbozvqf:p%40ss@aws-1-eu-central-1.pooler.supabase.com:5432/postgres",
    "a direct production URL is rewritten to production's IPv4 session pooler (aws-1), keeping the password as given",
  );
  assert.equal(toPooler(PROD), PROD, "a URL already in pooler form passes untouched");
  assert.doesNotThrow(() => assertProductionUrl(toPooler("postgresql://postgres:x@db.ozucdzovmcqvepbozvqf.supabase.co:5432/postgres")),
    "the rewritten URL still names production");

  // ── one pg_dump, pinned ───────────────────────────────────────────────────────────────────────────
  for (const schema of BASELINE_SCHEMAS) {
    assert.ok(PG_DUMP_ARGS.join(" ").includes(`-n ${schema}`), `${schema} is dumped`);
  }
  assert.ok(PG_DUMP_ARGS.includes("--schema-only"), "schema only — never a row of data in a public repository");
  assert.ok(PG_DUMP_DOCKER_IMAGE.startsWith(`postgres:${PG_DUMP_MAJOR}.`), "the nightly image is the same pg_dump major that wrote the file");

  // ── the committed file ───────────────────────────────────────────────────────────────────────────
  assert.ok(existsSync(BASELINE), `${BASELINE} is committed`);
  const committed = readFileSync(BASELINE, "utf8");
  assert.ok(committed.startsWith(BASELINE_HEADER), "the committed baseline carries the generated header");
  assert.equal(normalizeDump(committed), committed, "the committed baseline is normalised — refreshed with --write, never by hand");
  assert.doesNotMatch(committed, /^-- Data for Name:|^COPY |^INSERT INTO /m, "the committed baseline holds no row of data");
  assert.doesNotMatch(committed, /postgres(ql)?:\/\/[^\s'"]*@|eyJ[A-Za-z0-9_-]{20,}\.|sk_live_|re_[A-Za-z0-9]{20,}/, "the committed baseline holds no URL with a password, no JWT and no key");
  const committedObjects = splitObjects(committed).size;
  assert.ok(committedObjects > 5000, `the baseline is a whole production dump (${committedObjects} objects), not a fragment`);
  assert.ok(committed.includes("CREATE TABLE public.employees ("), "the employees table is in it");

  // ── the nightly leg ──────────────────────────────────────────────────────────────────────────────
  const wf = readFileSync(WORKFLOW, "utf8");
  const leg = /- name: Check schema baseline \(production\)\n([\s\S]*?)\n\n/.exec(wf)?.[1] ?? "";
  assert.match(leg, /id: schema_baseline_production/, "the nightly workflow has the schema-baseline leg");
  assert.match(leg, /run: pnpm run check:schema-baseline/, "the leg runs the package script");
  assert.match(leg, /continue-on-error: true/, "a failing leg never cancels the legs after it");
  assert.match(leg, /timeout-minutes: \d+/, "the leg has its own budget");
  assert.match(leg, /SCHEMA_BASELINE_DOCKER: "1"/, "the runner dumps with the pinned image, not whatever pg_dump it has");
  const reds = wf.match(/steps\.schema_baseline_production\.outcome == 'failure'/g) ?? [];
  assert.ok(reds.length >= 3, `a red baseline leg reaches the report, the Telegram alarm and the verdict (found ${reds.length})`);
  assert.match(wf, /SCHEMA_BASELINE_PRODUCTION: \$\{\{ steps\.schema_baseline_production\.outcome \}\}/, "the report shows the leg");

  // A migration is applied before its PR merges, so one merged just before the baseline commit can be
  // newer than the dump: the explanation window opens 24 hours before that commit, not at it.
  const cli = readFileSync("scripts/schema-baseline.mjs", "utf8");
  assert.match(cli, /const LOOKBACK_HOURS = 24;/, "the explanation window looks back 24 hours");
  assert.match(cli, /`--since=\$\{since\}`/, "migrations are chosen by date, not by commits after the baseline's");

  // The snapshot-placement checker reads every .sql file, and the baseline records production's hand-made
  // tables faithfully; it is left out of that one checker, exactly that file and nothing wider.
  const placement = readFileSync("scripts/check-sql-backup-placement.ts", "utf8");
  const skips = placement.split("\n").filter((l) => l.trim().startsWith("/^supabase") && l.includes("schema"));
  assert.deepEqual(
    skips.map((l) => l.trim()),
    [String.raw`/^supabase\/schema\/production\.sql$/,`],
    "the placement checker skips the generated baseline — exactly that file, never the whole folder",
  );

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["check:schema-baseline"], "node scripts/schema-baseline.mjs --check", "the package script the leg runs");

  // ── the restore check: can the file REBUILD production? ───────────────────────────────────────────
  // Roles belong to the cluster, so pg_dump never creates one: the rebuild must, for every role the file
  // makes an owner, grants to or names in a policy — read from pg_dump's own objects, keywords left out.
  const ROLES_FIXTURE = [
    "--",
    "-- Name: t; Type: TABLE; Schema: public; Owner: postgres",
    "--",
    "",
    "CREATE TABLE public.t (id integer);",
    "",
    "",
    "ALTER TABLE public.t OWNER TO app_owner;",
    "",
    "--",
    "-- Name: t p; Type: POLICY; Schema: public; Owner: postgres",
    "--",
    "",
    'CREATE POLICY p ON public.t FOR SELECT TO authenticated, "Odd Role" USING (true);',
    "",
    "--",
    "-- Name: TABLE t; Type: ACL; Schema: public; Owner: postgres",
    "--",
    "",
    "REVOKE ALL ON TABLE public.t FROM PUBLIC;",
    "GRANT SELECT ON TABLE public.t TO metabase;",
    "GRANT ALL ON TABLE public.t TO service_role WITH GRANT OPTION;",
    "",
    "--",
    "-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: analytics; Owner: postgres",
    "--",
    "",
    "ALTER DEFAULT PRIVILEGES FOR ROLE grantor_role IN SCHEMA analytics GRANT SELECT ON TABLES TO analytics_readonly;",
    "",
  ].join("\n");
  assert.deepEqual(
    rolesNamedIn(ROLES_FIXTURE),
    ["Odd Role", "analytics_readonly", "app_owner", "authenticated", "grantor_role", "metabase", "service_role"],
    "every owner, grantee, policy role and FOR ROLE is found, quoted names unquoted, PUBLIC left out",
  );
  const committedRoles = rolesNamedIn(committed);
  for (const role of ["postgres", "anon", "authenticated", "service_role"]) {
    assert.ok(committedRoles.includes(role), `the committed file names the platform role ${role}`);
  }
  assert.ok(committedRoles.includes("metabase"), "production's own roles are found too (metabase reads analytics)");
  assert.ok(!committedRoles.some((role) => ["PUBLIC", "CURRENT_USER", "CURRENT_ROLE", "SESSION_USER"].includes(role)), "no grantee keyword reads as a role");

  // The prelude: the missing roles (no login, no password), the extensions, then empty default privileges.
  const prelude = restorePrelude(["metabase", 'we"ird']);
  assert.match(prelude, /^CREATE ROLE "metabase" NOLOGIN;$/m, "a missing role is created");
  assert.match(prelude, /^CREATE ROLE "we""ird" NOLOGIN;$/m, "a role name is quoted as an identifier");
  assert.doesNotMatch(prelude, /\bPASSWORD\b|(?<!NO)LOGIN\b/, "a rebuilt role can never sign in");
  for (const { name, schema } of PRODUCTION_EXTENSIONS) {
    assert.ok(prelude.includes(`CREATE EXTENSION IF NOT EXISTS "${name}" WITH SCHEMA "${schema}";`), `the prelude creates ${name} in ${schema}`);
  }
  assert.ok(
    prelude.indexOf("CREATE ROLE") < prelude.indexOf("CREATE EXTENSION") &&
      prelude.indexOf("CREATE EXTENSION") < prelude.indexOf(CLEAR_DEFAULT_PRIVILEGES),
    "roles, then extensions, then the default privileges are cleared, all before the file",
  );
  assert.match(CLEAR_DEFAULT_PRIVILEGES, /RAISE EXCEPTION 'default privileges remain/, "a default privilege left behind stops the restore");
  assert.match(CLEAR_DEFAULT_PRIVILEGES, /FROM pg_default_acl a CROSS JOIN LATERAL aclexplode\(a\.defaclacl\)/, "every grantee of every default privilege is read");
  if (committed.includes("extensions.gin_trgm_ops")) {
    assert.ok(PRODUCTION_EXTENSIONS.some((e) => e.name === "pg_trgm" && e.schema === "extensions"), "the file uses pg_trgm, so the rebuild creates it");
  }

  // The file as psql is fed it: one line changes, so a psql error's line number is the file's own.
  const restorable = restorableBaseline(committed);
  const baseLines = committed.split("\n");
  const restoredLines = restorable.split("\n");
  assert.equal(restoredLines.length, baseLines.length, "the line count is kept");
  assert.deepEqual(
    restoredLines.flatMap((line, i) => (line === baseLines[i] ? [] : [line])),
    ["CREATE SCHEMA IF NOT EXISTS public;"],
    "the only change is that public, which every Supabase database already has, is created IF NOT EXISTS",
  );
  assert.throws(() => restorableBaseline("CREATE TABLE x ();"), /exactly one "CREATE SCHEMA public;" line/, "a file without it is refused, never fed half-changed");

  // It writes, so it runs only against a throwaway database on the runner itself.
  assert.doesNotThrow(() => assertScratchUrl("postgresql://supabase_admin@127.0.0.1:5432/postgres"), "the job's own container");
  assert.doesNotThrow(() => assertScratchUrl("postgresql://postgres@localhost:54322/postgres"), "a local supabase start");
  assert.throws(() => assertScratchUrl(PROD), /throwaway database on this machine/, "production's pooler is refused");
  assert.throws(() => assertScratchUrl(STAGING), /throwaway database on this machine/, "staging's pooler is refused");
  assert.throws(() => assertScratchUrl("postgresql://postgres:x@db.ozucdzovmcqvepbozvqf.supabase.co:5432/postgres"), /throwaway/, "production's direct host is refused");
  assert.throws(() => assertScratchUrl("postgresql://postgres.ozucdzovmcqvepbozvqf:pw@127.0.0.1:5432/postgres"), /names production/, "a tunnel to production on 127.0.0.1 is refused");
  assert.throws(() => assertScratchUrl(""), /SCHEMA_RESTORE_URL/, "no URL is refused, never defaulted");
  const fresh = freshnessQuery();
  for (const schema of BASELINE_SCHEMAS.filter((s) => s !== "public")) {
    assert.ok(fresh.includes(`'${schema}'`), `a database that already has ${schema} is not fresh`);
  }
  assert.ok(fresh.includes("relnamespace = 'public'::regnamespace"), "a database with anything in public is not fresh");

  // The weekly job: production's Postgres major, never on a pull request, no secret near the restore.
  const restoreWf = readFileSync(RESTORE_WORKFLOW, "utf8").replace(/\r\n/g, "\n");
  const image = /^\s+image: supabase\/postgres:(\d+)\.[\d.]+$/m.exec(restoreWf);
  assert.ok(image, "the restore runs in a pinned supabase/postgres image");
  assert.equal(Number(image[1]), RESTORE_PG_MAJOR, "the image runs production's Postgres major (move both when Supabase upgrades production)");
  const triggers = /^on:\n([\s\S]*?)\n(?=\S)/m.exec(restoreWf)?.[1] ?? "";
  assert.match(triggers, /^ {2}schedule:\n {4}- cron: "\d+ \d+ \* \* [0-6]"/m, "weekly: one fixed day of the week");
  assert.match(triggers, /^ {2}workflow_dispatch:/m, "it can be run by hand");
  assert.doesNotMatch(triggers, /pull_request/, "never on a pull request");
  assert.match(triggers, /^ {2}push:\n {4}branches: \[main\]\n {4}paths:\n/m, "a push runs it only on main, and only for the check's own files");
  const restoreJob = /^ {2}restore:\n([\s\S]*?)\n {2}notify:\n/m.exec(restoreWf)?.[1] ?? "";
  assert.match(restoreJob, /run: node scripts\/schema-baseline\.mjs --restore-check/, "the job runs the restore check");
  assert.match(restoreJob, /SCHEMA_BASELINE_DOCKER: "1"/, "with the pinned pg_dump image, the same one that wrote the file");
  assert.match(restoreJob, /SCHEMA_RESTORE_URL: postgresql:\/\/[^:@\s]+@127\.0\.0\.1:5432\//, "against the job's own container, no password in the URL");
  assert.doesNotMatch(restoreJob, /secrets\.|environment:/, "the restore job reads no secret");
  assert.doesNotMatch(restoreJob, /continue-on-error/, "a red restore turns the run red");
  const notifyJob = restoreWf.slice(restoreWf.indexOf("\n  notify:\n"));
  assert.match(notifyJob, /^ {4}needs: restore$/m, "the alarm waits for the restore");
  assert.match(notifyJob, /needs\.restore\.result != 'success'/, "and fires when it did not pass");
  assert.match(notifyJob, /^ {4}environment: main-secrets\b/m, "the Telegram pair is read in the main-only environment");
  assert.match(notifyJob, /TELEGRAM_ALERT_CHAT_ID: \$\{\{ secrets\.TELEGRAM_ALERT_CHAT_ID \}\}/, "the same channel as every scheduled alarm");
}
