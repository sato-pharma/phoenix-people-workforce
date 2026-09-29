import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// THE SUPER ADMIN READOUT for photo-vs-location distance (owner, 2026-09-29).
//
// The comparison itself shipped in #4781 — two independent GPS readings per capture instead of one
// copied twice. Nothing displayed it, so the evidence existed and no one could see it. This pins
// the readout, and in particular the three ways it could be quietly wrong:
//
//   1. computing the distance from the PIN on both sides, which is the defect #4781 removed and
//      would read a perfect 0 m on every row;
//   2. rendering "not measured" as though it were suspicion — every capture taken before
//      2026-09-29 has no photo coordinates at all, so that would accuse people the system simply
//      never measured; and
//   3. widening who can open the page. It is Super Admin only by the owner's 2026-09-24 decision,
//      and an integrity signal is his to read (AGENTS.md §4, CRM golden rule #1).

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function runLoaderTests() {
  // ── Marketing: the comparison is fed the PHOTO's fix, not the pin ────────────
  const marketing = read("../src/lib/verified-captures/marketing.ts");
  assert.ok(
    marketing.includes("assessCaptureTrust({"),
    "the marketing captures feed must compute the comparison",
  );
  // Both sides must be present, and they must be DIFFERENT sources.
  const photoFixFromPhotos =
    marketing.includes("photoFix: customerPhotos.get(customer.id) ?? null,")
    && marketing.includes("photoFix: pharmacyPhotos.get(row.id) ?? null,");
  assert.ok(
    photoFixFromPhotos,
    "photoFix must come from the evidence photo row — feeding it the venue row restores the copy bug",
  );
  assert.ok(
    !/photoFix:\s*\{[^}]*captured_latitude/.test(marketing),
    "photoFix must never be built from the venue's captured_* columns",
  );

  // The photo row can only supply a fix if the loader actually selects the columns.
  const storage = read("../src/lib/marketing-requests/evidence-photo-storage.ts");
  assert.ok(
    storage.includes("captured_latitude, captured_longitude, captured_accuracy_meters"),
    "the bulk photo loader must select the photo's own coordinates, or every row reads unmeasured",
  );
  assert.ok(
    storage.includes("export type MarketingEvidencePhotoIndexEntry"),
    "the photo index entry is a named exported type, so a caller cannot silently drop the fix",
  );

  // ── Direct orders: same, from the new photo_* columns ────────────────────────
  const directOrders = read("../src/lib/verified-captures/direct-orders.ts");
  assert.ok(
    directOrders.includes("photo_captured_at, photo_latitude, photo_longitude, photo_accuracy_meters"),
    "the direct-order feed must read the photo_* columns added by the 2026-09-29 migration",
  );
  assert.ok(
    directOrders.includes("assessCaptureTrust({"),
    "the direct-order feed must compute the comparison too",
  );
  assert.ok(
    !/photoFix:\s*\{\s*capturedAt: capturedByValidation/.test(directOrders),
    "the direct-order photoFix must be the photo's fix, never the pin's",
  );

  // ── Every row type carries it, so a surface cannot render a stale blank ──────
  const types = read("../src/lib/verified-captures/types.ts");
  const declarations = types.match(/photoTrust: CaptureTrustAssessment;/g) ?? [];
  assert.equal(
    declarations.length,
    3,
    "all three capture row types (marketing customer, marketing pharmacy, direct order) carry it",
  );
}

function runRenderTests() {
  const workspace = read("../src/components/admin/verified-captures-workspace.tsx");

  assert.ok(workspace.includes("function PhotoTrustBlock("), "the readout component must exist");

  // Rendered on all three: the customer, each of his pharmacies, and the direct-order storefront.
  const usages = workspace.match(/<PhotoTrustBlock trust=\{/g) ?? [];
  assert.equal(usages.length, 3, "the readout must render on all three capture surfaces");

  // "Not measured" must read as absence of evidence, never as suspicion. Pinned on the INK: it
  // shares the neutral slate of an ordinary field, while only a real contradiction goes rose.
  assert.ok(
    /unmeasured: \{ ink: "text-slate-500"/.test(workspace),
    "an unmeasured capture must render in neutral ink — it is not a finding against anyone",
  );
  assert.ok(
    /disagrees: \{ ink: "text-rose-700"/.test(workspace),
    "only a positive contradiction is rendered as one",
  );
  assert.ok(
    workspace.includes("not measured"),
    "the unmeasured case must say so in words, not leave the reader to infer it",
  );

  // Owner rules that apply to any new UI here.
  assert.ok(
    workspace.includes('className="space-y-0.5 rounded-none border-l-2 border-slate-200 pl-2"'),
    "square edges — the readout must not introduce a rounded corner",
  );
  // Scoped to the component's OWN body. A file-wide scan would catch unrelated `truncate` classes
  // elsewhere on the page and fail for something this change never touched.
  const start = workspace.indexOf("function PhotoTrustBlock(");
  const body = workspace.slice(start, workspace.indexOf("\nfunction ", start + 1));
  assert.ok(start > -1 && body.length > 200, "could not isolate the readout component body");
  // The CLASS, not the word: the component's own comment says "never truncated", and a bare
  // substring check on that reads as the very thing it is promising not to do.
  assert.ok(
    !/className="[^"]*\btruncate\b/.test(body) && !/className=\{`[^`]*\btruncate\b/.test(body),
    "no ellipsis truncation inside the readout — wrapping wins (owner rule)",
  );
  assert.ok(
    body.includes("break-words"),
    "the readout's own lines must wrap rather than overflow at 375px",
  );
}

function runAccessTests() {
  // The page was Super Admin only before this change and must stay that way. Adding a readout is
  // not a reason to widen a gate, and widening one is the owner's decision, never a side effect.
  const page = read("../app/(admin)/admin/verified-captures/page.tsx");
  assert.ok(
    page.includes("canOpenVerifiedCaptures(access)") && page.includes("redirect(\"/overview\")"),
    "the page guard must still redirect anyone who cannot open Verified Captures",
  );
  // Assert the PREDICATE, never the prose around it. The comment above this function legitimately
  // mentions the SFE Manager — to explain that the Validated Customers register admits them and
  // this gallery deliberately does not — so a substring scan of the file reads the opposite of the
  // rule it is checking.
  const access = read("../src/lib/verified-captures/access.ts");
  const start = access.indexOf("export function canOpenVerifiedCaptures(");
  const body = access.slice(start, access.indexOf("\n}", start));
  assert.ok(start > -1, "canOpenVerifiedCaptures must exist — it IS the gate");
  assert.ok(
    body.includes('access.role === "Super Admin"'),
    "Super Admin is the seat that may open it",
  );
  const roleChecks = body.match(/access\.role === "[^"]+"/g) ?? [];
  assert.deepEqual(
    roleChecks,
    ['access.role === "Super Admin"'],
    "access was NOT widened by this readout — adding a role here is the owner's call, never a side effect",
  );
}

export function runCaptureTrustReadoutTests() {
  runLoaderTests();
  runRenderTests();
  runAccessTests();
}
