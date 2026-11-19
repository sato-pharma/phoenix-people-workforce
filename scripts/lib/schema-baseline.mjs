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

/** Production's session pooler (port 5432, session mode, so pg_dump works through it). Production sits
 *  behind aws-1, not the aws-0 the staging tools default to: measured from .env.local, 2026-11-13. */
export const PRODUCTION_POOLER_HOST = "aws-1-eu-central-1.pooler.supabase.com";

/**
 * `db.<ref>.supabase.co` has ONLY an IPv6 address, and GitHub's runners have no IPv6: the first nightly
 * run on 2026-11-13 answered "Network unreachable". The session pooler answers on IPv4, so a direct URL
 * is rewritten to it (the user becomes `postgres.<ref>`). A URL already in pooler form passes untouched.
 */
export function toPooler(raw, host = PRODUCTION_POOLER_HOST) {
  const m = /^(\w+):\/\/([^:@]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:\d+\/(.+)$/.exec(raw);
  if (!m) return raw;
  const [, scheme, user, pass, ref, db] = m;
  return `${scheme}://${user}.${ref}:${pass}@${host}:5432/${db}`;
}

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

/** Splits text into nested parenthesised groups, quotes kept whole. null when the brackets do not balance. */
function parseGroups(text) {
  const root = { items: [] };
  const stack = [root];
  let chunk = "";
  const flush = () => {
    if (chunk) stack[stack.length - 1].items.push(chunk);
    chunk = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) return null;
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      chunk += text.slice(i, j + 1);
      i = j;
    } else if (ch === "(") {
      flush();
      const group = { items: [] };
      stack[stack.length - 1].items.push(group);
      stack.push(group);
    } else if (ch === ")") {
      flush();
      if (stack.length === 1) return null;
      stack.pop();
    } else {
      chunk += ch;
    }
  }
  flush();
  return stack.length === 1 ? root : null;
}

/** " AND " or " OR " when a group's top level is `(x) OP (y) OP (z)…` with one operator throughout, else null. */
function chainOperator(items) {
  if (items.length < 3 || items.length % 2 === 0) return null;
  let op = null;
  for (let k = 0; k < items.length; k += 1) {
    const item = items[k];
    if (k % 2 === 0) {
      if (typeof item === "string") return null;
    } else if (typeof item !== "string" || (item !== " AND " && item !== " OR ") || (op !== null && item !== op)) {
      return null;
    } else {
      op = item;
    }
  }
  return op;
}

function flattenGroup(group) {
  group.items = group.items.map((item) => (typeof item === "string" ? item : flattenGroup(item)));
  const op = chainOperator(group.items);
  if (op !== null) {
    for (;;) {
      const first = group.items[0];
      if (typeof first === "string" || chainOperator(first.items) !== op) break;
      group.items = [...first.items, ...group.items.slice(1)];
    }
  }
  return group;
}

function renderGroup(group) {
  return group.items.map((item) => (typeof item === "string" ? item : `(${renderGroup(item)})`)).join("");
}

/**
 * The same expression, written as Postgres writes it after parsing it again. Its parser folds a LEFT operand
 * that is itself a chain of the same operator into one chain: `((a) AND (b)) AND (c)` becomes
 * `(a) AND (b) AND (c)`. An expression Postgres BUILT nested — `x BETWEEN 1 AND 10` (an AND), a row
 * `IS DISTINCT FROM` (a chain of ORs) — therefore dumps with brackets that a restore of that dump no longer
 * has. Measured on the first restore, 19 Nov 2026: 10 CHECK constraints and 1 trigger WHEN, nothing else.
 * This folds exactly that, outside quotes, so the two compare equal. Only the leftmost operand, as the parser
 * does: a right-nested chain or a mixed AND/OR is left alone, so a change of meaning can never fold away.
 * Text whose brackets do not balance comes back unchanged.
 */
export function flattenBooleanChains(text) {
  const root = parseGroups(text);
  return root === null ? text : renderGroup(flattenGroup(root));
}

/**
 * The lines of one changed object that only one side has, in order: `-` the file's, `+` the other dump's.
 * Enough to name a difference in a run log without a diff tool; a line both sides hold is never shown.
 */
export function objectLineDiff(baseBody, liveBody) {
  const baseLines = baseBody.split("\n");
  const liveLines = liveBody.split("\n");
  const inLive = new Set(liveLines);
  const inBase = new Set(baseLines);
  return [
    ...baseLines.filter((line) => !inLive.has(line)).map((line) => `- ${line}`),
    ...liveLines.filter((line) => !inBase.has(line)).map((line) => `+ ${line}`),
  ];
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

// ── The restore check: can the file REBUILD production? (REC-041, the rebuild half) ───────────────────
//
// The nightly check above proves the file still DESCRIBES production. It cannot prove the file LOADS:
// production has no point-in-time recovery, so the day this file is needed is the day production is gone.
// scripts/schema-baseline.mjs --restore-check restores it into a throwaway Supabase Postgres, dumps that
// with the same pg_dump and normalising, and compares the two with compareDumps — the same rules, never a
// second copy (docs/security/schema-restore-check.md). These are the pure parts it needs.

/** Production's Postgres major. list_projects, 19 Nov 2026: database version 17.6.1.141, engine 17. The
 *  weekly job's supabase/postgres image must be this major (tests/schema-baseline.test.ts pins it). */
export const RESTORE_PG_MAJOR = 17;

/**
 * The extensions production has, in the schema each lives in (pg_extension, read 19 Nov 2026). pg_dump
 * with -n never dumps an extension, yet the file uses them: extensions.gin_trgm_ops and
 * extensions.similarity (pg_trgm) and extensions.pg_stat_statements. plpgsql ships with every database.
 * A new extension a migration starts using turns the weekly restore red until it is added here.
 */
export const PRODUCTION_EXTENSIONS = [
  { name: "pg_cron", schema: "pg_catalog" },
  { name: "pg_stat_statements", schema: "extensions" },
  { name: "pg_trgm", schema: "extensions" },
  { name: "pgcrypto", schema: "extensions" },
  { name: "supabase_vault", schema: "vault" },
  { name: "uuid-ossp", schema: "extensions" },
];

/** Not roles: the grantee keywords pg_dump may write. */
const NOT_ROLES = new Set(["PUBLIC", "CURRENT_ROLE", "CURRENT_USER", "SESSION_USER"]);

function unquoteRole(token) {
  const t = token.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
}

/**
 * Every role the dump grants to, revokes from, makes an owner, or names in a policy. Roles belong to the
 * cluster, not the database, so pg_dump never creates one, and a rebuild must create the ones the platform
 * does not (production's own: analytics_readonly, metabase, …). Read from pg_dump's own objects as
 * splitObjects finds them: ACL and DEFAULT ACL objects for grants, POLICY objects for their TO list, and
 * the OWNER TO line pg_dump writes after every object.
 */
export function rolesNamedIn(text) {
  const roles = new Set();
  const add = (token) => {
    const role = unquoteRole(token);
    if (role && !NOT_ROLES.has(role)) roles.add(role);
  };
  for (const [key, body] of splitObjects(text)) {
    for (const m of body.matchAll(/^ALTER [A-Z ]+ .+ OWNER TO ("[^"]+"|[^\s;]+);$/gm)) add(m[1]);
    if (key.startsWith("ACL ") || key.startsWith("DEFAULT ACL ")) {
      for (const m of body.matchAll(/^(?:GRANT|REVOKE|ALTER DEFAULT PRIVILEGES) .* (?:TO|FROM) ("[^"]+"|[^\s;]+)(?: WITH GRANT OPTION)?(?: GRANTED BY \S+)?;$/gm)) add(m[1]);
      for (const m of body.matchAll(/^ALTER DEFAULT PRIVILEGES FOR ROLE ("[^"]+"|\S+) /gm)) add(m[1]);
    }
    if (key.startsWith("POLICY ")) {
      const m = /^CREATE POLICY .+? ON \S+(?: AS \w+)?(?: FOR \w+)? TO (.+?)(?: USING \(| WITH CHECK \(|;$)/m.exec(body);
      if (m) for (const token of m[1].split(",")) add(token);
    }
  }
  return [...roles].sort();
}

/**
 * Empties pg_default_acl. pg_dump writes every object's grants on the assumption that it was created with
 * the BUILT-IN privileges and nothing more — it never revokes what a default privilege added. A Supabase
 * database is born with default privileges that grant ALL on every new table, sequence and function in
 * public to anon and authenticated (production still carries supabase_admin's: the baseline's own DEFAULT
 * ACL objects). Restored over them, every table would come back writable by the browser roles that PR 562
 * took away. So they are cleared first; the file's DEFAULT ACL objects, which pg_dump writes LAST, put back
 * exactly production's once every object exists. A schema-scoped entry only adds, so every grantee goes; a
 * global entry REPLACES the built-in privileges, so it is set back to them (owner ALL, PUBLIC on functions
 * and types), which removes it. Anything left raises, and the restore stops before the file.
 */
export const CLEAR_DEFAULT_PRIVILEGES = `DO $clear$
DECLARE
  d record;
  kind text;
  owner_name text;
  scope text;
BEGIN
  FOR d IN
    SELECT a.defaclrole, a.defaclnamespace, a.defaclobjtype, x.grantee
    FROM pg_default_acl a CROSS JOIN LATERAL aclexplode(a.defaclacl) x
    WHERE a.defaclnamespace <> 0 OR x.grantee <> a.defaclrole
  LOOP
    kind := CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
                                  WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END;
    owner_name := pg_get_userbyid(d.defaclrole);
    scope := CASE WHEN d.defaclnamespace = 0 THEN ''
                  ELSE format(' IN SCHEMA %I', (SELECT nspname FROM pg_namespace WHERE oid = d.defaclnamespace)) END;
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %s', owner_name, scope, kind,
                   CASE WHEN d.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(d.grantee)) END);
  END LOOP;
  FOR d IN SELECT defaclrole, defaclobjtype FROM pg_default_acl WHERE defaclnamespace = 0 LOOP
    kind := CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
                                  WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END;
    owner_name := pg_get_userbyid(d.defaclrole);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL ON %s TO %I', owner_name, kind, owner_name);
    IF d.defaclobjtype IN ('f', 'T') THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL ON %s TO PUBLIC', owner_name, kind);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_default_acl) THEN
    RAISE EXCEPTION 'default privileges remain after clearing: %',
      (SELECT string_agg(pg_get_userbyid(defaclrole) || '/' || defaclobjtype || '/' || defaclnamespace, ', ') FROM pg_default_acl);
  END IF;
END
$clear$;`;

/**
 * The SQL a rebuild runs BEFORE the file: what pg_dump -n does not carry — the roles it names that the
 * database lacks (NOLOGIN, no password), the extensions it uses, and empty default privileges.
 */
export function restorePrelude(missingRoles) {
  const ident = (name) => `"${name.replace(/"/g, '""')}"`;
  return [
    "-- Written by scripts/schema-baseline.mjs --restore-check: what the baseline needs and pg_dump -n does not carry.",
    "SET client_min_messages = warning;",
    ...missingRoles.map((role) => `CREATE ROLE ${ident(role)} NOLOGIN;`),
    ...PRODUCTION_EXTENSIONS.map(({ name, schema }) => `CREATE EXTENSION IF NOT EXISTS ${ident(name)} WITH SCHEMA ${ident(schema)};`),
    CLEAR_DEFAULT_PRIVILEGES,
    "",
  ].join("\n");
}

/**
 * The file as a rebuild feeds it to psql. Every Supabase database already has `public`, and the file creates
 * it because pg_dump was told `-n public`, so that ONE statement becomes `IF NOT EXISTS`; nothing else
 * changes, and the line count stays the same, so a psql error's line number is the file's own.
 */
export function restorableBaseline(text) {
  const lines = text.split("\n");
  const at = lines.flatMap((line, i) => (line === "CREATE SCHEMA public;" ? [i] : []));
  if (at.length !== 1) {
    throw new Error(`the baseline must hold exactly one "CREATE SCHEMA public;" line, found ${at.length}`);
  }
  lines[at[0]] = "CREATE SCHEMA IF NOT EXISTS public;";
  return lines.join("\n");
}

/** The query that proves the target is a fresh database: none of the baseline's schemas but `public`, and nothing in `public`. */
export function freshnessQuery() {
  const others = BASELINE_SCHEMAS.filter((s) => s !== "public").map((s) => `'${s}'`).join(", ");
  return (
    `select (select count(*) from pg_namespace where nspname in (${others}))` +
    " + (select count(*) from pg_class where relnamespace = 'public'::regnamespace)"
  );
}

const SCRATCH_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The restore writes, so it runs only against a throwaway database on this machine — never a project URL. */
export function assertScratchUrl(url) {
  if (!url) {
    throw new Error("no scratch database URL: set SCHEMA_RESTORE_URL to the throwaway supabase/postgres container");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the scratch database URL does not parse");
  }
  if (!SCRATCH_HOSTS.has(parsed.hostname)) {
    throw new Error(`the restore target must be a throwaway database on this machine (127.0.0.1), not ${parsed.hostname}`);
  }
  if (`${parsed.username} ${parsed.pathname}`.includes(PRODUCTION_REF)) {
    throw new Error("the scratch database URL names production");
  }
}
