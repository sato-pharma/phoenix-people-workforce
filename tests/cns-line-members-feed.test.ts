import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  cnsLineMemberEmailHashes,
  handleCnsLineMembersRequest,
  hashMemberEmail,
  type CnsLineMemberRow,
} from "../src/lib/employees/cns-line-members.ts";

// The CNS Line detailing app's server asks GET /api/integrations/cns-line/members whether an email
// belongs to somebody working on the CNS line today (owner: "integrate with phoenix and accept any
// email from cns line"). What this suite pins:
//
//  - the door is on its own token: unset answers 503 (no development bypass), a missing or wrong
//    bearer 401, and the read is never reached on either;
//  - the hashes are HMAC-SHA256 under their own key, CNS_LINE_MEMBERS_HASH_KEY: an unset key answers
//    503 before any read, and the body names the format (`hash: "hmac-sha256"`). A plain SHA-256 of
//    a first.second@satopharma.com roster can be reversed in seconds by guessing names;
//  - the answer is hashes ONLY — no address, name or HR id ever leaves Phoenix;
//  - WHO is in: active by the directory's own rule, on the line whose `lines.code` is `cns`, both
//    the work and the personal address, each once.

const TOKEN = "cns-line-members-test-token";
const KEY = "cns-line-members-test-hash-key";
const NOW = new Date("2026-11-10T08:00:00.000Z");

function sha(email: string, key = KEY) {
  return createHmac("sha256", key).update(email.trim().toLowerCase(), "utf8").digest("hex");
}

function plainSha256(email: string) {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

function request(authorization?: string) {
  return new Request("https://phoenix.test/api/integrations/cns-line/members", {
    headers: authorization ? { authorization } : {},
  });
}

const CNS = { code: "cns", name: "CNS" };
const PEDIA = { code: "pedia", name: "Pedia" };

function row(over: Partial<CnsLineMemberRow> & { hr_id: string }): CnsLineMemberRow {
  return {
    full_name: `Person ${over.hr_id}`,
    job_title: "Medical Representative",
    employment_status: "active",
    payroll_eligible: true,
    organogram_visible: true,
    position_id: null,
    line_id: 3,
    work_email: null,
    personal_email: null,
    lines: CNS,
    ...over,
  };
}

const ROWS: CnsLineMemberRow[] = [
  // In: work and personal address, messy case and spaces.
  row({ hr_id: "C-1", full_name: "Mona Adel", work_email: "  Mona.Adel@SatoPharma.com ", personal_email: "mona.home@gmail.com" }),
  // In: her work address is C-1's personal one in another case — one hash, not two.
  row({ hr_id: "C-2", full_name: "Karim Samy", work_email: "MONA.HOME@gmail.com", personal_email: "karim.samy@yahoo.com" }),
  // In: on leave is active by the directory's rule; embed returned as a one-element array.
  row({ hr_id: "C-3", full_name: "Hala Nabil", employment_status: "on_leave", work_email: "hala.nabil@satopharma.com", lines: [CNS] }),
  // In: a personal address alone is enough.
  row({ hr_id: "C-4", full_name: "Omar Fathy", personal_email: "omar.fathy@outlook.com" }),
  // Out: resigned.
  row({ hr_id: "C-90", full_name: "Resigned Rep", employment_status: "resigned", organogram_visible: false, work_email: "resigned.rep@satopharma.com" }),
  // Out: terminated, even with the organogram flag left on.
  row({ hr_id: "C-91", full_name: "Terminated Rep", employment_status: "terminated", work_email: "terminated.rep@satopharma.com", personal_email: "terminated.home@gmail.com" }),
  // Out: active but hidden from the directory (organogram_visible false).
  row({ hr_id: "C-92", full_name: "Hidden Rep", organogram_visible: false, work_email: "hidden.rep@satopharma.com" }),
  // Out: active, but on Pedia.
  row({ hr_id: "P-1", full_name: "Pedia Rep", line_id: 1, lines: PEDIA, work_email: "pedia.rep@satopharma.com" }),
  // Out: active with no line at all.
  row({ hr_id: "X-1", full_name: "No Line", line_id: null, lines: null, work_email: "no.line@satopharma.com" }),
  // Out: a vacancy node on CNS is not a person.
  row({ hr_id: "C-VAC", full_name: "Vacant Territory", job_title: "Vacancy", work_email: "vacant@satopharma.com" }),
  // In but contributes nothing: neither address is well-formed.
  row({ hr_id: "C-5", full_name: "Bad Address", work_email: "not-an-email", personal_email: "two@@at.com" }),
];

const EXPECTED = [
  "Mona.Adel@SatoPharma.com",
  "mona.home@gmail.com",
  "karim.samy@yahoo.com",
  "hala.nabil@satopharma.com",
  "omar.fathy@outlook.com",
].map((email) => sha(email)).sort();

const EXCLUDED = [
  "resigned.rep@satopharma.com",
  "terminated.rep@satopharma.com",
  "terminated.home@gmail.com",
  "hidden.rep@satopharma.com",
  "pedia.rep@satopharma.com",
  "no.line@satopharma.com",
  "vacant@satopharma.com",
].map((email) => sha(email));

export async function runCnsLineMembersFeedTests() {
  const noRead = async (): Promise<CnsLineMemberRow[]> => {
    throw new Error("the read must not run before the token is accepted");
  };

  // --- unset token: 503, never a dev bypass, never a read -------------------------------------
  for (const token of [undefined, "", "   "]) {
    const response = await handleCnsLineMembersRequest(request(`Bearer ${TOKEN}`), { token, hashKey: KEY, loadRows: noRead });
    assert.equal(response.status, 503, `an unset token (${JSON.stringify(token)}) answers 503`);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  // --- unset hash key: 503 exactly like a missing token, never a read -------------------------
  for (const hashKey of [undefined, "", "   "]) {
    const response = await handleCnsLineMembersRequest(request(`Bearer ${TOKEN}`), { token: TOKEN, hashKey, loadRows: noRead });
    assert.equal(response.status, 503, `an unset hash key (${JSON.stringify(hashKey)}) answers 503`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "not_configured" });
  }

  // --- missing or wrong bearer: 401, never a read ---------------------------------------------
  for (const authorization of [undefined, "Bearer wrong-token", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, "Bearer "]) {
    const response = await handleCnsLineMembersRequest(request(authorization), { token: TOKEN, hashKey: KEY, loadRows: noRead });
    assert.equal(response.status, 401, `authorization ${JSON.stringify(authorization)} answers 401`);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  // --- the right bearer: 200, the contract shape, hashes only ---------------------------------
  const ok = await handleCnsLineMembersRequest(request(`Bearer ${TOKEN}`), {
    token: TOKEN,
    hashKey: KEY,
    loadRows: async () => ROWS,
    now: () => NOW,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const raw = await ok.text();
  const body = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["count", "emailHashes", "generatedAt", "hash", "line"]);
  assert.equal(body.hash, "hmac-sha256", "the body names its hash format, so the app refuses an old-format list");
  assert.equal(body.line, "cns");
  assert.equal(body.generatedAt, NOW.toISOString());
  assert.deepEqual(body.emailHashes, EXPECTED, "exactly the active CNS members' addresses, HMAC'd under the key, sorted");
  for (const email of ["Mona.Adel@SatoPharma.com", "omar.fathy@outlook.com"]) {
    assert.ok(
      !(body.emailHashes as string[]).includes(plainSha256(email)),
      "never a plain SHA-256: an unkeyed first.second@satopharma.com list reverses in seconds",
    );
  }
  assert.equal(body.count, EXPECTED.length);
  for (const hash of body.emailHashes as string[]) assert.match(hash, /^[0-9a-f]{64}$/);

  assert.ok(!raw.includes("@"), "no plain email anywhere in the answer");
  for (const leaked of ["C-1", "C-2", "Mona", "Karim", "satopharma", "gmail"]) {
    assert.ok(!raw.toLowerCase().includes(leaked.toLowerCase()), `no name, HR id or address part (${leaked}) in the answer`);
  }

  // --- who is out, one by one -----------------------------------------------------------------
  const hashes = new Set(body.emailHashes as string[]);
  for (const hash of EXCLUDED) assert.ok(!hashes.has(hash), "inactive, hidden, non-CNS and vacancy rows are excluded");
  assert.ok(hashes.has(sha("omar.fathy@outlook.com")), "a personal address alone is included");
  assert.equal(new Set(body.emailHashes as string[]).size, (body.emailHashes as string[]).length, "no duplicates");

  // --- the hash is of the address trimmed and lower-cased; a malformed one is skipped -----------
  assert.equal(hashMemberEmail("  Mona.Adel@SatoPharma.com ", KEY), sha("mona.adel@satopharma.com"));
  assert.equal(hashMemberEmail("not-an-email", KEY), null);
  assert.equal(hashMemberEmail("a b@c.com", KEY), null);
  assert.equal(hashMemberEmail(null, KEY), null);
  assert.deepEqual(cnsLineMemberEmailHashes([], KEY), []);

  // --- the key is in the hash: one address under two keys gives two different hashes ----------
  const underA = hashMemberEmail("mona.adel@satopharma.com", "key-a");
  const underB = hashMemberEmail("mona.adel@satopharma.com", "key-b");
  assert.ok(underA && underB);
  assert.notEqual(underA, underB, "the same email under two keys must hash differently");
  assert.equal(underA, sha("mona.adel@satopharma.com", "key-a"));
  assert.notDeepEqual(
    cnsLineMemberEmailHashes(ROWS, "key-a"),
    cnsLineMemberEmailHashes(ROWS, "key-b"),
    "the whole list changes with the key",
  );

  // --- a failed read is a 500 that says nothing about the data --------------------------------
  const failed = await handleCnsLineMembersRequest(request(`Bearer ${TOKEN}`), {
    token: TOKEN,
    hashKey: KEY,
    loadRows: async () => {
      throw new Error('relation "employees" does not exist: secret.person@satopharma.com');
    },
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.ok(!(await failed.text()).includes("@"), "a failure never echoes the error text");

  // --- the route reads its own token and never the shared cron secret -------------------------
  const route = readFileSync(new URL("../app/api/integrations/cns-line/members/route.ts", import.meta.url), "utf8");
  assert.match(
    route,
    /handleCnsLineMembersRequest\(request, \{\s*token: process\.env\.CNS_LINE_MEMBERS_TOKEN,\s*hashKey: process\.env\.CNS_LINE_MEMBERS_HASH_KEY,\s*\}\)/,
    "the route reads its own token and its own, separate hash key",
  );
  assert.doesNotMatch(route.replace(/\/\/.*$/gm, ""), /\bCRON_SECRET\b/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/, "GET only");

  const lib = readFileSync(new URL("../src/lib/employees/cns-line-members.ts", import.meta.url), "utf8");
  const libCode = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(libCode, /\bline_name\b/, "never the dead line_name column");
  assert.match(
    lib,
    /loadReferenceLines\(\)\)\s*\.filter\(\(line\) => line\.id !== null && \(line\.code \?\? ""\)\.trim\(\)\.toLowerCase\(\) === CNS_LINE_CODE\)/,
    "the line resolves by code from the cached reference list, never by id",
  );

  const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", import.meta.url), "utf8");
  assert.match(
    registry,
    /tokenApi\(\{ authMode: "machine-token", methods: \["GET"\], pattern: "\/api\/integrations\/cns-line\/members"/,
    "registered as a GET-only machine-token route",
  );
}
