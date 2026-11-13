// The production schema baseline — the pure half (REC-041, F-DB-010).
//
// `supabase/schema/production.sql` is a schema-only pg_dump of production's application schemas,
// normalised so that two dumps of an unchanged database are byte-identical. It is the file a fresh
// database is rebuilt from, and the nightly Migration Drift Check compares production against it.
// The impure half (running pg_dump, git, the file) is scripts/schema-baseline.mjs; everything here
// is a function of its arguments so the test can call it without a database.

/** The schemas the application owns. Supabase-managed ones (auth, storage, realtime, vault, cron,
 *  extensions, graphql) are rebuilt by Supabase itself; dated snapshot schemas are being dropped
 *  (REC-040) and are data, not structure. */
export const BASELINE_SCHEMAS = ["public", "au", "private", "analytics", "recovery", "internal"];

/** Exactly what `--write` and `--check` pass to pg_dump. One list, so the two can never disagree. */
export const PG_DUMP_ARGS = ["--schema-only", ...BASELINE_SCHEMAS.flatMap((s) => ["-n", s])];

/** pg_dump's major version is pinned: a different major prints a different preamble and the whole
 *  file would read as drift. Local and CI must both run this one. */
export const PG_DUMP_MAJOR = 18;
export const PG_DUMP_DOCKER_IMAGE = "postgres:18.4-alpine";

export const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";

export const BASELINE_HEADER = [
  "-- Phoenix production schema baseline (REC-041). GENERATED — never edit by hand.",
  "--",
  `-- A schema-only pg_dump ${PG_DUMP_MAJOR} of production's application schemas (${BASELINE_SCHEMAS.join(", ")}),`,
  "-- normalised by scripts/lib/schema-baseline.mjs. Refresh it after applying a migration to production:",
  "--   node scripts/schema-baseline.mjs --write",
  "-- The nightly Migration Drift Check compares production with it: docs/schema-baseline.md.",
  "",
].join("\n");

/**
 * Two dumps of an unchanged database must be byte-identical. pg_dump 18 writes a random
 * `\restrict <key>` / `\unrestrict <key>` pair on every run, and stamps both server and client
 * versions; Windows can hand back CRLF. None of that is schema.
 */
export function normalizeDump(text) {
  let lf = text.replace(/\r\n?/g, "\n");
  // Idempotent: the committed file already carries the header, and re-normalising it must not stack a second.
  if (lf.startsWith(BASELINE_HEADER)) lf = lf.slice(BASELINE_HEADER.length);
  const lines = lf
    .split("\n")
    .filter((line) => !/^\\(un)?restrict\s/.test(line))
    .filter((line) => !/^-- Dumped (from database|by pg_dump) version /.test(line));
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return `${BASELINE_HEADER}\n${body}\n`;
}

/** The URL must name production — the baseline describes production and nothing else. */
export function assertProductionUrl(url) {
  if (!url) throw new Error("no database URL: set DATABASE_URL, or SUPABASE_DB_URL in .env.local");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the database URL does not parse");
  }
  const names = `${parsed.username} ${parsed.hostname}`;
  if (!names.includes(PRODUCTION_REF)) {
    throw new Error(
      `the database URL does not name production (${PRODUCTION_REF}) — the baseline describes production only`,
    );
  }
}

const TOC = /^-- Name: (.+?); Type: (.+?); Schema: (.+?); Owner: .*$/;

/**
 * Splits a dump into its objects, keyed `TYPE schema.name`, from pg_dump's own table-of-contents
 * comments. The owner is left out of the key, so a change of owner reads as a changed object.
 */
export function splitObjects(text) {
  const objects = new Map();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let key = null;
  let body = [];
  const flush = () => {
    if (key === null) return;
    // The `--` that opens the NEXT object's comment block is not this object's: without this, the
    // last object in a dump reads as changed the moment anything is appended after it.
    while (body.length > 1 && /^(--)?\s*$/.test(body[body.length - 1])) body.pop();
    const prior = objects.get(key);
    objects.set(key, (prior === undefined ? "" : `${prior}\n`) + body.join("\n").trim());
  };
  for (const line of lines) {
    const m = TOC.exec(line);
    if (m) {
      flush();
      key = `${m[2]} ${m[3]}.${m[1]}`;
      body = [line];
    } else if (key !== null) {
      body.push(line);
    }
  }
  flush();
  return objects;
}

/** What differs between the committed baseline and a fresh dump, by object. */
export function compareDumps(baselineText, liveText) {
  const base = splitObjects(baselineText);
  const live = splitObjects(liveText);
  const added = [...live.keys()].filter((k) => !base.has(k)).sort();
  const removed = [...base.keys()].filter((k) => !live.has(k)).sort();
  const changed = [...live.keys()].filter((k) => base.has(k) && base.get(k) !== live.get(k)).sort();
  return { added, removed, changed, objects: live.size };
}

/**
 * The word a migration would contain if it made this change: the object's own name, without a
 * function's argument list and without the table a constraint, trigger or policy is named after.
 * `FUNCTION public.f(a integer)` → `f`; `CONSTRAINT public.t t_pkey` → `t_pkey`.
 */
export function objectWord(key) {
  const name = key.slice(key.indexOf(" ") + 1);
  const bare = name.slice(name.indexOf(".") + 1).replace(/\(.*$/, "");
  const parts = bare.split(" ");
  return parts[parts.length - 1].replace(/"/g, "");
}

/**
 * Splits drift into what a migration on `main` newer than the baseline explains, and what nothing
 * explains. Explained drift is a baseline that is behind (refresh it). Unexplained drift is a change
 * made to production with no migration on `main` saying so: by hand, or a migration applied whose
 * pull request has not merged.
 */
export function explainDrift(diff, migrationTexts) {
  const corpus = migrationTexts.join("\n").toLowerCase();
  const explained = [];
  const unexplained = [];
  for (const key of [...diff.added, ...diff.removed, ...diff.changed]) {
    const word = objectWord(key).toLowerCase();
    (word.length > 2 && corpus.includes(word) ? explained : unexplained).push(key);
  }
  return { explained, unexplained };
}
