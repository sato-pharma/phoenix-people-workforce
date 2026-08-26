import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  loadMarketingPharmacyLicensesByPharmacyIds,
  MARKETING_EVIDENCE_BUCKET,
  MARKETING_PHARMACY_LICENSE_EVIDENCE_TYPE,
  storeMarketingPharmacyLicense,
} from "../src/lib/marketing-requests/evidence-photo-storage.ts";
import {
  evidenceStatusFromInput,
  normalizeMarketingValidationInput,
} from "../src/lib/marketing-requests/service.ts";
import type { MarketingValidationInput } from "../src/lib/marketing-requests/types.ts";
import {
  parsePharmacyLicenseDataUrl,
  PHARMACY_LICENSE_ACCEPT_ATTRIBUTE,
  PHARMACY_LICENSE_BUCKET,
  PHARMACY_LICENSE_MAX_BYTES,
  pharmacyLicenseFillsTheIdentityGap,
  pharmacyLicensePrompt,
} from "../src/lib/venues/pharmacy-license.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The pharmacy trade licence (رخصة الصيدلية) — owner's instruction, 2026-08-25.
//
// A distributor code is an identity check Phoenix gets for free: a real company invoiced a real
// pharmacy under that name. A venue with NO code in ANY distributor has none of that, and the
// storefront photo proves only WHERE it is. The licence closes the gap — its printed trade name is
// compared against the name on the shop sign in the photo the same submission already carries.
//
// What these guard, in order of what it costs to get wrong:
//   1. The licence must NEVER raise evidence status. It is identity, not presence — if it could
//      push a pharmacy to `complete` it would launder a shop nobody visited into system_validated.
//   2. It must land in its OWN bucket. `direct-order-evidence` and `marketing-evidence` are
//      JPEG-only with a 2MB cap, and that allow-list is a second wall behind the live-capture
//      parser. Widening either to admit a PDF takes the wall down for storefront photos too.
//   3. Both desks must accept exactly the same files, or "the licence is on file" means two
//      different things depending on which screen wrote it.
//   4. The prompt must be a FLAG, never a gate — the system flags, it never rejects.
// ─────────────────────────────────────────────────────────────────────────────

const pdfBytes = Buffer.from("%PDF-1.7 a scanned trade licence");
const pdfDataUrl = `data:application/pdf;base64,${pdfBytes.toString("base64")}`;
const pngDataUrl = `data:image/png;base64,${Buffer.from("a scanner app png").toString("base64")}`;
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from("a photograph of the wall").toString("base64")}`;

/** Records every storage and table call so each assertion reads what was actually attempted. */
function fakeSupabase(options: { failInsert?: boolean; rows?: Array<Record<string, unknown>> } = {}) {
  const calls = {
    inserted: [] as Array<Record<string, unknown>>,
    removed: [] as Array<{ bucket: string; paths: string[] }>,
    signedBatches: [] as Array<{ bucket: string; paths: string[] }>,
    uploaded: [] as Array<{ bucket: string; contentType: string; path: string; size: number }>,
  };

  const client = {
    from() {
      const builder: Record<string, unknown> = {
        eq: () => builder,
        in: () => builder,
        insert: async (row: Record<string, unknown>) => {
          calls.inserted.push(row);
          return { error: options.failInsert ? { message: "index write refused" } : null };
        },
        order: () => builder,
        select: () => builder,
        then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
          resolve({ data: options.rows ?? [], error: null }),
      };
      return builder;
    },
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrls(paths: string[]) {
            calls.signedBatches.push({ bucket, paths });
            return {
              data: paths.map((path) => ({ error: null, path, signedUrl: `https://signed.example/${bucket}/${path}` })),
              error: null,
            };
          },
          async remove(paths: string[]) {
            calls.removed.push({ bucket, paths });
            return { error: null };
          },
          async upload(path: string, bytes: Buffer, opts: { contentType: string }) {
            calls.uploaded.push({ bucket, contentType: opts.contentType, path, size: bytes.length });
            return { error: null };
          },
        };
      },
    },
  };

  return { calls, client };
}

/**
 * A submission carrying a licence and NOTHING else — no GPS, no timestamp, no storefront photo.
 * This is the shape that must stay `missing`: it is the exact shape an attacker or a lazy rep would
 * produce if a licence were allowed to stand in for a visit.
 */
function licenceOnlyInput(): MarketingValidationInput {
  return {
    customers: [
      {
        capturedAccuracyMeters: null,
        capturedAddress: null,
        capturedAt: null,
        capturedLatitude: null,
        capturedLongitude: null,
        customerType: "clinic",
        displayName: "Dr Haytham Clinic",
        evidenceHasTimestamp: false,
        evidencePhotoCapturedAt: null,
        evidencePhotoDataUrl: null,
        evidencePhotoName: null,
        pharmacies: [
          {
            capturedAccuracyMeters: null,
            capturedAddress: null,
            capturedAt: null,
            capturedLatitude: null,
            capturedLongitude: null,
            displayName: "Hazem Pharmacy",
            evidenceHasTimestamp: false,
            evidencePhotoCapturedAt: null,
            evidencePhotoDataUrl: null,
            evidencePhotoName: null,
            licenseFileDataUrl: pdfDataUrl,
            licenseFileName: "hazem-licence.pdf",
            // Stated since 2026-08-26 — capture refuses a venue nobody named rather than
            // defaulting it, and this fixture has to be a pharmacy for the code below to belong.
            venueType: "pharmacy",
            // A code is present because Marketing REFUSES a pharmacy without one
            // (normalizeValidationPharmacy) — so "no code at all" is not a shape this path can
            // even produce. It changes nothing about what is under test: the licence is here, the
            // visit evidence is not, and the status must still be `missing`.
            vendorCodes: [{ distributorId: 1, distributorPharmacyCode: "PH-404" }],
          },
        ],
      },
    ],
  };
}

export async function runPharmacyLicenseEvidenceTests() {
  // ── 1. THE HEADLINE: a licence can never stand in for a visit ────────────────────────────────
  {
    const normalized = normalizeMarketingValidationInput(licenceOnlyInput());
    const pharmacy = normalized.customers[0]!.pharmacies[0]!;

    assert.equal(
      pharmacy.licenseFileDataUrl,
      pdfDataUrl,
      "the licence must survive normalization — otherwise it is accepted by the form and quietly dropped",
    );
    assert.equal(
      evidenceStatusFromInput(pharmacy),
      "missing",
      "EVIDENCE LAUNDERING: a licence must NOT raise evidence status. It proves WHO the shop is, never that anyone stood in front of it — a licence that could reach `complete` would mint system_validated for a venue nobody visited",
    );
    assert.equal(
      evidenceStatusFromInput(normalized.customers[0]!),
      "missing",
      "and the customer it hangs under is unaffected too",
    );
  }

  // ── 2. Its own bucket, and the two existing evidence buckets untouched ───────────────────────
  {
    assert.notEqual(
      PHARMACY_LICENSE_BUCKET,
      MARKETING_EVIDENCE_BUCKET,
      "the licence must not share the marketing evidence bucket — that bucket is JPEG-only on purpose",
    );
    assert.equal(PHARMACY_LICENSE_BUCKET, "pharmacy-licenses");

    const licenseMigration = readFileSync(
      new URL("../supabase/migrations/20260825120000_pharmacy_license_evidence.sql", import.meta.url),
      "utf8",
    );
    assert.match(
      licenseMigration,
      /'pharmacy-licenses',\s*\n\s*false,/,
      "the licence bucket must be PRIVATE — a trade licence carries a real business's registration details",
    );
    assert.match(
      licenseMigration,
      /array\['image\/jpeg', 'image\/png', 'application\/pdf'\]/,
      "and must admit the three types the domain module accepts",
    );

    // The whole reason a fourth bucket exists. If a later change widens either of these instead,
    // the second wall behind the live-capture parser is gone and this says so.
    const directOrderMigration = readFileSync(
      new URL("../supabase/migrations/20260805024500_direct_order_pharmacy_validation.sql", import.meta.url),
      "utf8",
    );
    assert.match(
      directOrderMigration,
      /'direct-order-evidence', false, 2097152, array\['image\/jpeg'\]/,
      "STOREFRONT WALL DOWN: direct-order-evidence must stay JPEG-only at 2MB — the licence has its own bucket precisely so this one never has to move",
    );
    const marketingMigration = readFileSync(
      new URL("../supabase/migrations/20260804140000_marketing_evidence_photo_bucket.sql", import.meta.url),
      "utf8",
    );
    assert.match(
      marketingMigration,
      /array\['image\/jpeg'\]/,
      "STOREFRONT WALL DOWN: marketing-evidence must stay JPEG-only for the same reason",
    );
  }

  // ── 3. One parser, so both desks accept exactly the same files ───────────────────────────────
  {
    assert.equal(parsePharmacyLicenseDataUrl(pdfDataUrl).extension, "pdf");
    assert.equal(parsePharmacyLicenseDataUrl(pdfDataUrl).contentType, "application/pdf");
    assert.deepEqual(parsePharmacyLicenseDataUrl(pdfDataUrl).bytes, pdfBytes);
    assert.equal(parsePharmacyLicenseDataUrl(pngDataUrl).extension, "png");
    assert.equal(parsePharmacyLicenseDataUrl(jpegDataUrl).extension, "jpg");

    // A base64 payload that travelled through a JSON pretty-printer arrives line-wrapped. Decoded
    // as-is it yields DIFFERENT bytes rather than failing, which is a corrupt file nobody notices.
    const wrapped = jpegDataUrl.replace(";base64,", ";base64,\n  ");
    assert.deepEqual(
      parsePharmacyLicenseDataUrl(wrapped).bytes,
      parsePharmacyLicenseDataUrl(jpegDataUrl).bytes,
      "whitespace in the payload must be stripped, not decoded",
    );

    for (const refused of [
      "",
      "   ",
      null,
      undefined,
      "https://example.com/licence.pdf",
      `data:image/heic;base64,${Buffer.from("an iphone default").toString("base64")}`,
      `data:text/html;base64,${Buffer.from("<script>").toString("base64")}`,
      "data:application/pdf;base64,",
    ]) {
      assert.throws(
        () => parsePharmacyLicenseDataUrl(refused),
        /pharmacy licence/i,
        `a licence of ${JSON.stringify(refused)} must be refused with a sentence naming the licence`,
      );
    }

    const oversize = `data:application/pdf;base64,${Buffer.alloc(PHARMACY_LICENSE_MAX_BYTES + 1, 0x41).toString("base64")}`;
    assert.throws(
      () => parsePharmacyLicenseDataUrl(oversize),
      /under 5 MB/,
      "over the ceiling must be refused by SIZE, and say so — a bucket-level rejection reaches the rep as an opaque failure",
    );

    // The picker's filter and the parser's allow-list are the same list, so a rep can never choose
    // a file the browser offered and watch the server refuse it.
    assert.equal(PHARMACY_LICENSE_ACCEPT_ATTRIBUTE, "image/jpeg,image/png,application/pdf");
  }

  // ── 4. A prompt, never a gate ────────────────────────────────────────────────────────────────
  {
    assert.equal(
      pharmacyLicenseFillsTheIdentityGap({ distributorCodeCount: 0, venueType: "pharmacy" }),
      true,
      "a codeless pharmacy is exactly the case the owner asked about",
    );
    assert.equal(
      pharmacyLicenseFillsTheIdentityGap({ distributorCodeCount: 1, venueType: "pharmacy" }),
      false,
      "a pharmacy with a distributor code is already vouched for by that distributor",
    );
    assert.equal(
      pharmacyLicenseFillsTheIdentityGap({ distributorCodeCount: 0, venueType: "nursery" }),
      false,
      "a nursery has no distributor account BY ITS NATURE — prompting there asks for a pharmacy trade licence that does not exist",
    );

    assert.equal(
      pharmacyLicensePrompt({ distributorCodeCount: 2, hasLicenseOnFile: false, venueType: "pharmacy" }),
      null,
      "nothing is said when nothing is missing",
    );
    const asking = pharmacyLicensePrompt({ distributorCodeCount: 0, hasLicenseOnFile: false, venueType: "pharmacy" });
    const comparing = pharmacyLicensePrompt({ distributorCodeCount: 0, hasLicenseOnFile: true, venueType: "pharmacy" });
    assert.ok(asking && /Attach/.test(asking), "with no licence yet, the prompt asks for one");
    assert.ok(comparing && /shop sign/.test(comparing), "with one on file, it names the comparison to make");
    assert.notEqual(asking, comparing, "the two states must not say the same sentence");
  }

  // ── 5. Marketing: stored in the licence bucket, indexed as a licence ─────────────────────────
  {
    const { calls, client } = fakeSupabase();
    const path = await storeMarketingPharmacyLicense({
      fileDataUrl: pdfDataUrl,
      originalFileName: "hazem-licence.pdf",
      pharmacyId: "11111111-2222-3333-4444-555555555555",
      supabase: client as never,
      uploadedByHrId: "HR-001",
    });

    assert.equal(calls.uploaded.length, 1);
    assert.equal(
      calls.uploaded[0]!.bucket,
      PHARMACY_LICENSE_BUCKET,
      "WRONG BUCKET: marketing-evidence rejects a PDF outright, so the upload would fail and the rep would be told nothing useful",
    );
    assert.equal(calls.uploaded[0]!.contentType, "application/pdf");
    assert.match(path, /\.pdf$/, "the path must carry the real extension — a PDF served from a .jpg path downloads instead of opening");

    const indexed = calls.inserted[0]!;
    assert.equal(indexed.evidence_type, MARKETING_PHARMACY_LICENSE_EVIDENCE_TYPE);
    assert.equal(indexed.evidence_type, "pharmacy_license");
    assert.equal(
      indexed.storage_bucket,
      PHARMACY_LICENSE_BUCKET,
      "the index row must name the bucket the file is actually in, or the read path signs a URL into the wrong one",
    );
    assert.equal(
      indexed.has_timestamp,
      false,
      "a licence is a DOCUMENT — claiming a capture timestamp it does not have manufactures provenance",
    );
    for (const captureColumn of ["captured_at", "captured_latitude", "captured_longitude"]) {
      assert.ok(
        indexed[captureColumn] == null,
        `${captureColumn} must stay null — writing this submission's GPS onto a scanned document invents where it came from`,
      );
    }
  }

  // ── 6. A failed index write must not leave an orphan file ────────────────────────────────────
  {
    const { calls, client } = fakeSupabase({ failInsert: true });
    await assert.rejects(
      storeMarketingPharmacyLicense({
        fileDataUrl: pngDataUrl,
        originalFileName: "licence.png",
        pharmacyId: "aaaa",
        supabase: client as never,
        uploadedByHrId: null,
      }),
      /Unable to record the pharmacy licence/,
    );
    assert.deepEqual(
      calls.removed.map((entry) => entry.bucket),
      [PHARMACY_LICENSE_BUCKET],
      "the stored object must be removed from the bucket it was actually written to",
    );
  }

  // ── 7. Reading them back: chunked, newest-first, signed from the licence bucket ──────────────
  {
    const { calls, client } = fakeSupabase({
      rows: [
        { content_type: "application/pdf", created_at: "2026-08-25T09:00:00Z", entity_id: "pharm-1", storage_path: "pharmacy/pharm-1-license.pdf" },
        { content_type: "image/png", created_at: "2026-08-01T09:00:00Z", entity_id: "pharm-1", storage_path: "pharmacy/pharm-1-license.png" },
      ],
    });
    const found = await loadMarketingPharmacyLicensesByPharmacyIds({
      pharmacyIds: ["pharm-1"],
      supabase: client as never,
    });

    assert.equal(found.get("pharm-1")?.contentType, "application/pdf", "re-attaching writes a NEW index row, so the newest must win");
    assert.equal(
      calls.signedBatches[0]!.bucket,
      PHARMACY_LICENSE_BUCKET,
      "signing from the wrong bucket yields a URL that 404s, which reads on screen as 'no licence attached'",
    );

    // A PostgREST `.in()` carrying several hundred ids returns `{ data: [], error: null }` — an
    // empty set indistinguishable from "none of these venues has a licence". Chunked at 50.
    const storageSource = readFileSync(
      new URL("../src/lib/marketing-requests/evidence-photo-storage.ts", import.meta.url),
      "utf8",
    );
    const licenceReader = storageSource.slice(storageSource.indexOf("export async function loadMarketingPharmacyLicensesByPharmacyIds"));
    assert.match(
      licenceReader,
      /index \+= 50/,
      "UNCHUNKED `.in()`: a few hundred pharmacy ids come back as an empty array with no error, silently erasing every licence from the screen",
    );
  }

  // ── 8. Direct Orders: signed from the licence bucket, never from the row's storage_bucket ────
  {
    const validationSource = readFileSync(
      new URL("../src/lib/direct-orders/pharmacy-validation.ts", import.meta.url),
      "utf8",
    );
    const licenceSigning = validationSource.slice(
      validationSource.indexOf("const licensePath = row.license_storage_path"),
      validationSource.indexOf("licenseUrl = signedLicense?.signedUrl"),
    );
    assert.ok(licenceSigning.length > 0, "the licence signing block must still exist");
    assert.match(
      licenceSigning,
      /\.from\(PHARMACY_LICENSE_BUCKET\)/,
      "the licence must be signed from the licence bucket — `storage_bucket` on that row describes the STOREFRONT photo and always will",
    );

    // The verdict is three-valued on purpose. NULL means nobody was asked, and it must never be
    // written as a `false` that reads on screen as "checked, and it does not match".
    assert.match(
      validationSource,
      /input\.licenseNameMatchesSign != null \? Boolean\(input\.licenseNameMatchesSign\) : null/,
      "the licence verdict must stay three-valued — a defaulted false accuses a pharmacy nobody checked",
    );
    assert.match(
      validationSource,
      /const licenseColumns = licenseVerdict == null \? \{\} : \{ license_name_matches_sign: licenseVerdict \}/,
      "and an unanswered verdict must write NO column at all, rather than overwriting an earlier answer with null",
    );
  }
}
