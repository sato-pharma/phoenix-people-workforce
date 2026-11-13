import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  BASELINE_HEADER,
  BASELINE_SCHEMAS,
  PG_DUMP_ARGS,
  PG_DUMP_DOCKER_IMAGE,
  PG_DUMP_MAJOR,
  assertProductionUrl,
  toPooler,
  compareDumps,
  explainDrift,
  normalizeDump,
  objectWord,
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
 *   - the nightly leg is wired: it runs, reds the verdict and has its own budget.
 */

const BASELINE = "supabase/schema/production.sql";
const WORKFLOW = ".github/workflows/migration-drift-check.yml";

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

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["check:schema-baseline"], "node scripts/schema-baseline.mjs --check", "the package script the leg runs");
}
