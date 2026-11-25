import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseOwnerOpsArgs } from "../scripts/lib/owner-ops-args.ts";
import { installOwnerOpsDryRunFence, type FencedWrite } from "../scripts/lib/owner-ops-fence.ts";
import { stripComments } from "./support/comment-strip.ts";

// scripts/owner-ops.ts — the owner's desk jobs (link a doctor's pharmacies, merge pharmacy copies,
// pin a pharmacy) run from the app's own code against the database in .env.local (owner, 25 Nov 2026:
// "do X" is done by Claude from the code, never through his screens or the spare's dev server).
//
// Because it writes the PRODUCTION database, the one promise this suite pins is:
//   1. A RUN IS A DRY RUN unless the literal token --apply is on the command line;
//   2. the dry run's fence never hands a write to the network — a table write is answered in the
//      process, a message to the outside world is answered "sent" and never sent — while a read passes;
//   3. the runner installs that fence BEFORE it imports any app module, and only skips it under --apply.

const SUPABASE = "https://ozucdzovmcqvepbozvqf.supabase.co";
const RUNNER = "scripts/owner-ops.ts";
const PHARMACY = "18390e99-c269-456b-92fe-70994258a714";
const OTHER = "eea2f512-0000-4000-8000-000000000001";

function plan(argv: string[]) {
  const parsed = parseOwnerOpsArgs(argv);
  assert.equal(parsed.ok, true, `${argv.join(" ")} parses (${parsed.ok ? "" : parsed.error})`);
  return (parsed as Extract<typeof parsed, { ok: true }>).plan;
}

function refused(argv: string[], why: string) {
  const parsed = parseOwnerOpsArgs(argv);
  assert.equal(parsed.ok, false, `${argv.join(" ")} is refused: ${why}`);
}

function dryRunIsTheDefault() {
  const link = ["link-doctor", "--body", "body.json"];
  const merge = ["merge-venues", "--survivor", PHARMACY, "--loser", OTHER, "--reason", "same shop, same codes"];
  const pin = ["pin-pharmacy", "--pharmacy", PHARMACY, "--lat", "29.95", "--lng", "31.25"];

  for (const argv of [link, merge, pin]) {
    assert.equal(plan(argv).apply, false, `${argv[0]} with no --apply is a DRY RUN`);
    assert.equal(plan([...argv, "--apply"]).apply, true, `${argv[0]} --apply writes`);
    assert.equal(plan([argv[0]!, "--apply", ...argv.slice(1)]).apply, true, "--apply counts wherever it stands");
    refused([...argv, "--apply=yes"], "--apply takes no value, so --apply=yes is never a quiet write");
    refused([...argv, "--apply=false"], "and --apply=false is never a quiet write either");
    refused([...argv, "apply"], "a bare word is not the flag");
  }

  refused(["merge-venues", "--survivor", PHARMACY, "--loser", OTHER, "--reason", "x", "--lat", "31"], "a flag of another job");
  refused(["pin-pharmacy", "--pharmacy", PHARMACY, "--pharmacy", OTHER, "--lat", "29.9", "--lng", "31.2"], "a flag given twice");
  refused(["merge-venues", "--survivor", PHARMACY, "--loser", PHARMACY, "--reason", "x"], "a pharmacy merged into itself");
  refused(["merge-venues", "--survivor", "not-a-uuid", "--loser", OTHER, "--reason", "x"], "an id that is not a uuid");
  refused(["merge-venues", "--survivor", PHARMACY, "--loser", OTHER], "a merge with no reason");
  refused(["pin-pharmacy", "--pharmacy", PHARMACY, "--lat", "32.90", "--lng", "24.09"], "an Aswan pin with latitude and longitude swapped lands outside Egypt");
  refused(["pin-pharmacy", "--pharmacy", PHARMACY, "--lat", "abc", "--lng", "31.25"], "a latitude that is not a number");
  refused(["--apply", "pin-pharmacy"], "a run that does not name its job first");
  refused(["fix-everything"], "a job the runner does not know");
}

type Call = { url: string; method: string };

async function theFenceSendsNoWrite() {
  const calls: Call[] = [];
  const real = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: String(init?.method ?? "GET").toUpperCase() });
    return new Response(JSON.stringify([{ id: PHARMACY, captured_latitude: null }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const original = globalThis.fetch;
  const log: FencedWrite[] = [];
  try {
    assert.equal(installOwnerOpsDryRunFence(log, real), true, "the fence installs");
    assert.equal(installOwnerOpsDryRunFence(log, real), false, "a second install is refused, never a fence around a fence");

    const table = `${SUPABASE}/rest/v1/marketing_pharmacies`;
    const read = await fetch(`${table}?id=eq.${PHARMACY}&select=id`);
    assert.equal(read.status, 200, "a read comes back");
    await fetch(`${table}?id=eq.${PHARMACY}`, {
      method: "PATCH",
      headers: { prefer: "return=representation", "content-type": "application/json" },
      body: JSON.stringify({ captured_latitude: 29.95 }),
    });
    const inserted = await fetch(`${SUPABASE}/rest/v1/marketing_customer_pharmacy_links`, {
      method: "POST",
      headers: { prefer: "return=representation", "content-type": "application/json" },
      body: JSON.stringify({ customer_id: OTHER, pharmacy_id: PHARMACY }),
    });
    assert.equal(inserted.status, 201, "an insert is answered as PostgREST would answer it");
    await fetch(`${table}?id=eq.${OTHER}`, { method: "DELETE" });
    await fetch("https://api.telegram.org/bot0/sendMessage", { method: "POST", body: "{}" });
    await fetch("https://api.resend.com/emails", { method: "POST", body: "{}" });

    const writesSent = calls.filter((call) => call.method !== "GET");
    assert.deepEqual(writesSent, [], "NOTHING but a read reached the network — no table write, no Telegram, no e-mail");
    assert.equal(calls[0]?.url.includes("select=id"), true, "the read itself passed through untouched");
    assert.deepEqual(
      log.map((write) => `${write.method} ${write.target}`),
      [
        "PATCH marketing_pharmacies",
        "POST marketing_customer_pharmacy_links",
        "DELETE marketing_pharmacies",
        "POST api.telegram.org/bot0/sendMessage",
        "POST api.resend.com/emails",
      ],
      "every write is listed for the dry run's report, and the read is not",
    );
    assert.match(log[0]!.detail, /captured_latitude/, "the listed write says what it would have changed");
  } finally {
    globalThis.fetch = original;
  }
}

function theRunnerFencesBeforeItLoadsTheApp() {
  const source = stripComments(readFileSync(RUNNER, "utf8"));
  assert.doesNotMatch(source, /^import[^;]*from\s+["'](?:@\/|\.\.\/src\/)/m, "no app module is imported statically — it would load before the fence");
  // The helpers above main() hold the app imports and run only when main() calls them, so the order
  // that matters is inside main(): the fence before the first app import or helper call it makes.
  const mainAt = source.indexOf("async function main()");
  assert.ok(mainAt > 0, "the runner has a main()");
  const body = source.slice(mainAt);
  const fence = body.indexOf("installOwnerOpsDryRunFence(fenced)");
  const firstAppUse = Math.min(
    ...[/await import\(["']@\//, /await liveAccessContext\(/, /await run(?:LinkDoctor|MergeVenues|PinPharmacy)\(/]
      .map((pattern) => body.search(pattern))
      .filter((at) => at >= 0),
  );
  assert.ok(fence > 0, "main() installs the dry-run fence");
  assert.ok(Number.isFinite(firstAppUse), "main() reaches the app's own code");
  assert.ok(fence < firstAppUse, "the fence is installed BEFORE main() first reaches an app module");
  assert.match(source, /^await main\(\);\s*$/m, "main() is the one thing the script runs");
  assert.match(
    source,
    /if \(plan\.apply\) \{[^]{0,200}?assertTreeIsCurrent\("owner-ops"\);\s*\} else \{\s*installOwnerOpsDryRunFence\(fenced\);/,
    "only --apply skips the fence, and --apply first refuses a tree behind origin/main",
  );
  assert.match(source, /refuseUnknownFlags\(/, "an unknown flag (--aply) is refused, never read as a dry run the caller thinks wrote");
}

export async function runOwnerOpsRunnerTests() {
  dryRunIsTheDefault();
  await theFenceSendsNoWrite();
  theRunnerFencesBeforeItLoadsTheApp();
}
