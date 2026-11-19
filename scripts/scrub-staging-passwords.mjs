// Replace, on STAGING only, every password hash that is identical to production's hash for the
// same account — public.app_auth_users by login, auth.users by id. Production is read, never
// written (its session is set read-only). No hash or digest is ever printed: counts only.
//
// Run from the primary checkout (for its env files):  node <this file>            (dry run)
//                                                     node <this file> --apply    (writes staging)
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const require = createRequire("F:/Phoenix Workforce/phoenix-workforce/package.json");
const postgres = require("postgres");

const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";
const STAGING_REF = "cifwmndunmlxjhyjugxa";
const ENV_FILES = [".env.staging.rls.local", ".env.production.rls.local", ".env.local"];
const POOLER = {
  [PRODUCTION_REF]: "aws-1-eu-central-1.pooler.supabase.com",
  [STAGING_REF]: "aws-0-eu-central-1.pooler.supabase.com",
};

function envVar(name) {
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  throw new Error("missing " + name);
}
function refOf(url) {
  return /db\.([a-z0-9]{20})\.supabase\.co/.exec(url)?.[1] ?? /postgres\.([a-z0-9]{20})[:@]/.exec(url)?.[1] ?? null;
}
function toPooler(raw) {
  const m = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  if (!m) return raw;
  const [, scheme, user, pass, ref, , db] = m;
  return `${scheme}://${user}.${ref}:${pass}@${POOLER[ref]}:5432/${db}`;
}

const apply = process.argv.includes("--apply");
const stagingUrl = envVar("PHOENIX_STAGING_DATABASE_URL");
const productionUrl = envVar("PHOENIX_PRODUCTION_DATABASE_URL");
if (refOf(stagingUrl) !== STAGING_REF) throw new Error(`staging variable names ${refOf(stagingUrl)}, not staging. Nothing done.`);
if (refOf(productionUrl) !== PRODUCTION_REF) throw new Error(`production variable names ${refOf(productionUrl)}, not production. Nothing done.`);

const prod = postgres(toPooler(productionUrl), { max: 1, prepare: false });
const stg = postgres(toPooler(stagingUrl), { max: 1, prepare: false, onnotice: () => {} });

async function matches() {
  const prodApp = new Map((await prod`select login_id, md5(password_hash) h from public.app_auth_users where coalesce(password_hash,'') <> ''`).map((r) => [r.login_id, r.h]));
  const prodAuth = new Map((await prod`select id::text id, md5(encrypted_password) h from auth.users where coalesce(encrypted_password,'') <> ''`).map((r) => [r.id, r.h]));
  const stgApp = await stg`select login_id, md5(password_hash) h from public.app_auth_users where coalesce(password_hash,'') <> ''`;
  const stgAuth = await stg`select id::text id, md5(encrypted_password) h from auth.users where coalesce(encrypted_password,'') <> ''`;
  const app = { same: [], sameDigest: [], differs: 0, stagingOnly: 0, total: stgApp.length };
  for (const r of stgApp) {
    if (!prodApp.has(r.login_id)) app.stagingOnly++;
    else if (prodApp.get(r.login_id) === r.h) { app.same.push(r.login_id); app.sameDigest.push(r.h); }
    else { app.differs++; (app.differList ??= []).push(r.login_id); }
  }
  const auth = { same: [], sameDigest: [], differs: 0, stagingOnly: 0, total: stgAuth.length };
  for (const r of stgAuth) {
    if (!prodAuth.has(r.id)) auth.stagingOnly++;
    else if (prodAuth.get(r.id) === r.h) { auth.same.push(r.id); auth.sameDigest.push(r.h); }
    else { auth.differs++; (auth.differList ??= []).push(r.id); }
  }
  return { app, auth, prodAppCount: prodApp.size, prodAuthCount: prodAuth.size };
}
const pgArray = (items) => "{" + items.map((s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") + "}";
const summary = (m) => ({
  production_rows_read: { app_auth_users: m.prodAppCount, auth_users: m.prodAuthCount },
  staging_app_auth_users: { total: m.app.total, same_hash_as_production: m.app.same.length, different_hash: m.app.differs, staging_only: m.app.stagingOnly },
  staging_auth_users: { total: m.auth.total, same_hash_as_production: m.auth.same.length, different_hash: m.auth.differs, staging_only: m.auth.stagingOnly },
});

try {
  await prod`set default_transaction_read_only = on`;
  const before = await matches();
  console.log(JSON.stringify({ phase: "before", ...summary(before) }, null, 1));
  if (process.argv.includes("--explain")) {
    const CLONE = "2026-08-30T00:00:00Z";
    const [a] = await stg.unsafe(
      `select count(*) filter (where updated_at < $2::timestamptz) untouched_since_clone,
              count(*) filter (where updated_at >= $2::timestamptz) changed_on_staging_after_clone,
              count(*) filter (where is_test_persona) test_personas, count(*) filter (where is_active) active
         from public.app_auth_users where login_id = any($1::text[])`,
      [pgArray(before.app.differList ?? []), CLONE],
    );
    const [p] = await prod.unsafe(
      `select count(*) filter (where updated_at >= $2::timestamptz) changed_on_production_after_clone
         from public.app_auth_users where login_id = any($1::text[])`,
      [pgArray(before.app.differList ?? []), CLONE],
    );
    const [b] = await stg.unsafe(
      `select count(*) filter (where updated_at < $2::timestamptz) untouched_since_clone,
              count(*) filter (where updated_at >= $2::timestamptz) changed_on_staging_after_clone
         from auth.users where id = any($1::uuid[])`,
      [pgArray(before.auth.differList ?? []), CLONE],
    );
    console.log(JSON.stringify({ different_app_auth_users: { ...a, ...p }, different_auth_users: b }));
  }
  if (apply) {
    const NEW_HASH = "extensions.crypt(encode(extensions.gen_random_bytes(32), 'hex'), extensions.gen_salt('bf', 8))";
    const appResult = await stg.begin(async (tx) =>
      tx.unsafe(
        `update public.app_auth_users u set password_hash = ${NEW_HASH}
           from unnest($1::text[], $2::text[]) as m(login_id, h)
          where u.login_id = m.login_id and md5(u.password_hash) = m.h`,
        [pgArray(before.app.same), pgArray(before.app.sameDigest)],
      ),
    );
    console.log(JSON.stringify({ app_auth_users_rows_replaced: appResult.count }));
    const authResult = await stg.begin(async (tx) =>
      tx.unsafe(
        `update auth.users u set encrypted_password = ${NEW_HASH}
           from unnest($1::uuid[], $2::text[]) as m(id, h)
          where u.id = m.id and md5(u.encrypted_password) = m.h`,
        [pgArray(before.auth.same), pgArray(before.auth.sameDigest)],
      ),
    );
    console.log(JSON.stringify({ auth_users_rows_replaced: authResult.count }));
    const after = await matches();
    console.log(JSON.stringify({ phase: "after", ...summary(after) }, null, 1));
  }
} finally {
  await prod.end({ timeout: 5 });
  await stg.end({ timeout: 5 });
}
