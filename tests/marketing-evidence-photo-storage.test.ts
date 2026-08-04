import { strict as assert } from "node:assert";

import {
  buildMarketingEvidencePhotoPath,
  createMarketingEvidencePhotoSignedUrl,
  loadMarketingEvidencePhoto,
  MARKETING_EVIDENCE_BUCKET,
  parseMarketingEvidencePhotoDataUrl,
  storeMarketingEvidencePhoto,
} from "../src/lib/marketing-requests/evidence-photo-storage.ts";
import {
  evidenceStatusFromInput,
  normalizeMarketingValidationInput,
} from "../src/lib/marketing-requests/service.ts";
import type { MarketingValidationInput } from "../src/lib/marketing-requests/types.ts";

const timestamp = "2026-08-02T14:05:20.772Z";
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from("a-real-jpeg-frame").toString("base64")}`;

/**
 * A field capture that is complete in every respect. Individual cases below remove exactly one
 * thing from it, so a failure names the missing piece rather than "the fixture is wrong".
 */
function capturedInput(overrides: {
  customerPhotoDataUrl?: string | null;
  customerPhotoName?: string | null;
  pharmacyPhotoDataUrl?: string | null;
  pharmacyPhotoName?: string | null;
} = {}): MarketingValidationInput {
  return {
    customers: [
      {
        capturedAccuracyMeters: 12,
        capturedAddress: "PQGW+3GR, Radwan Mansour St, Faqous, Al-Sharqia",
        capturedAt: timestamp,
        capturedLatitude: 30.72513372,
        capturedLongitude: 31.79614512,
        customerType: "clinic",
        displayName: "Dr Haytham Clinic",
        evidenceHasTimestamp: true,
        evidencePhotoCapturedAt: timestamp,
        evidencePhotoDataUrl: "customerPhotoDataUrl" in overrides ? overrides.customerPhotoDataUrl : jpegDataUrl,
        evidencePhotoName: "customerPhotoName" in overrides ? overrides.customerPhotoName : "customer-live-2026-08-02T14:05:20.772Z.jpg",
        pharmacies: [
          {
            capturedAccuracyMeters: 8,
            capturedAddress: "PQFW+W9M, Faqous, Al-Sharqia",
            capturedAt: timestamp,
            capturedLatitude: 30.7248449,
            capturedLongitude: 31.7958458,
            displayName: "Hazem Pharmacy",
            evidenceHasTimestamp: true,
            evidencePhotoCapturedAt: timestamp,
            evidencePhotoDataUrl: "pharmacyPhotoDataUrl" in overrides ? overrides.pharmacyPhotoDataUrl : jpegDataUrl,
            evidencePhotoName: "pharmacyPhotoName" in overrides ? overrides.pharmacyPhotoName : "pharmacy-live-2026-08-02T14:19:54.278Z.jpg",
            vendorCodes: [{ distributorId: 1, distributorPharmacyCode: "PH-001" }],
          },
        ],
      },
    ],
  };
}

/** Records every storage and table call so each assertion can read what was actually attempted. */
function fakeSupabase(options: {
  evidenceRow?: Record<string, unknown> | null;
  failInsert?: boolean;
  failUpload?: boolean;
} = {}) {
  const calls = {
    inserted: [] as Array<Record<string, unknown>>,
    removed: [] as string[][],
    signed: [] as Array<{ path: string; ttl: number }>,
    uploaded: [] as Array<{ bucket: string; contentType: string; path: string; size: number }>,
  };

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        delete: () => ({ in: async () => ({ error: null }) }),
        eq: () => builder,
        insert: async (row: Record<string, unknown>) => {
          if (table === "marketing_evidence_files") calls.inserted.push(row);
          return { error: options.failInsert ? { message: "index write refused" } : null };
        },
        limit: () => builder,
        maybeSingle: async () => ({ data: options.evidenceRow ?? null, error: null }),
        order: () => builder,
        select: () => builder,
      };
      return builder;
    },
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrl(path: string, ttl: number) {
            calls.signed.push({ path, ttl });
            return { data: { signedUrl: `https://signed.example/${bucket}/${path}?ttl=${ttl}` }, error: null };
          },
          async remove(paths: string[]) {
            calls.removed.push(paths);
            return { error: null };
          },
          async upload(path: string, bytes: Buffer, opts: { contentType: string }) {
            calls.uploaded.push({ bucket, contentType: opts.contentType, path, size: bytes.length });
            return { error: options.failUpload ? { message: "bucket unavailable" } : null };
          },
        };
      },
    },
  };

  return { calls, client: client as never };
}

export async function runMarketingEvidencePhotoStorageTests() {
  // ── The defect this file exists for ──
  // Until 2026-08-04 the browser sent `evidencePhotoName` and dropped the captured bytes, so a
  // record reached evidence_status 'complete' — and through it validation_status
  // 'system_validated' — on the strength of a STRING. Three live production rows still assert
  // photographic proof of a real shop front that nobody can retrieve. A name with no image is now
  // refused outright (owner decision, 2026-08-04).
  assert.throws(
    () => normalizeMarketingValidationInput(capturedInput({ customerPhotoDataUrl: null })),
    /live capture photo name but no photo/i,
    "a customer photo NAME arriving without the image must be refused, never stored as proof",
  );
  assert.throws(
    () => normalizeMarketingValidationInput(capturedInput({ pharmacyPhotoDataUrl: null })),
    /live capture photo name but no photo/i,
    "the same refusal must apply to a pharmacy — 2 of the 3 bad production rows are pharmacies",
  );

  // …and the image is what makes it complete, not the filename. No name, no bytes, but a full GPS
  // fix and timestamp: legal to save, and must NOT claim proof.
  const nameless = normalizeMarketingValidationInput(
    capturedInput({
      customerPhotoDataUrl: null,
      customerPhotoName: null,
      pharmacyPhotoDataUrl: null,
      pharmacyPhotoName: null,
    }),
  );
  assert.equal(
    nameless.customers[0].evidenceStatus,
    "pending",
    "a located, timestamped record with no retained image must never read 'complete'",
  );
  assert.equal(
    nameless.customers[0].validationStatus,
    "pending",
    "and so must never be promoted to system_validated, which is what puts it in the request dropdown",
  );

  // ── The status rule itself: the IMAGE is what earns 'complete', never the filename ──
  // Asserted directly rather than only through normalizeMarketingValidationInput, because normalize
  // now refuses a name-without-image before the status is ever computed. That refusal is the outer
  // gate; this is the inner one, and an inner gate no test can reach is an inner gate that rots.
  // Everything below is a complete field capture EXCEPT for the one field named in each case.
  const fullyCaptured = {
    capturedAt: timestamp,
    capturedLatitude: 30.72513372,
    capturedLongitude: 31.79614512,
    evidenceHasTimestamp: true,
    evidencePhotoCapturedAt: timestamp,
    evidencePhotoDataUrl: jpegDataUrl,
    evidencePhotoName: "customer-live-2026-08-02T14:05:20.772Z.jpg",
  };
  assert.equal(evidenceStatusFromInput(fullyCaptured), "complete");
  assert.equal(
    evidenceStatusFromInput({ ...fullyCaptured, evidencePhotoDataUrl: null }),
    "pending",
    "a filename with GPS and a timestamp but NO retained image must never read 'complete' — this exact shape is what the 3 live production rows are, and what promoted them to system_validated",
  );
  assert.equal(
    evidenceStatusFromInput({ ...fullyCaptured, evidencePhotoName: null }),
    "pending",
    "and the image alone is not enough either — the capture must still be named and timestamped",
  );
  assert.equal(
    evidenceStatusFromInput({
      capturedAt: null,
      capturedLatitude: null,
      capturedLongitude: null,
      evidenceHasTimestamp: false,
      evidencePhotoCapturedAt: null,
      evidencePhotoDataUrl: null,
      evidencePhotoName: null,
    }),
    "missing",
    "nothing captured at all stays 'missing', so a desk entry is not misreported as partial evidence",
  );

  // A genuine capture — image included — still reaches 'complete', so the fix does not break the
  // field flow it is protecting.
  const complete = normalizeMarketingValidationInput(capturedInput());
  assert.equal(complete.customers[0].evidenceStatus, "complete");
  assert.equal(complete.customers[0].pharmacies[0].evidenceStatus, "complete");
  assert.equal(
    complete.customers[0].evidencePhotoDataUrl,
    jpegDataUrl,
    "the validated image must survive normalization so the insert path can store it",
  );

  // ── JPEG only: the claim is "taken live, here, now" ──
  const parsed = parseMarketingEvidencePhotoDataUrl(jpegDataUrl);
  assert.equal(parsed.contentType, "image/jpeg");
  assert.equal(parsed.bytes.length, 17);
  assert.throws(
    () => parseMarketingEvidencePhotoDataUrl(`data:image/png;base64,${Buffer.from("png").toString("base64")}`),
    /JPEG/i,
    "a PNG (i.e. not the camera canvas) must be refused",
  );
  assert.throws(() => parseMarketingEvidencePhotoDataUrl("data:image/jpeg;base64,"), /JPEG|empty/i);
  assert.throws(
    () => normalizeMarketingValidationInput(capturedInput({ customerPhotoDataUrl: "not-a-data-url" })),
    /valid image|JPEG/i,
    "a malformed image must fail at normalize time, before any row is written",
  );

  // ── Paths never collide across entity types ──
  const customerPath = buildMarketingEvidencePhotoPath({ entityId: "9d9edb77-245f", entityType: "customer" });
  const pharmacyPath = buildMarketingEvidencePhotoPath({ entityId: "9d9edb77-245f", entityType: "pharmacy" });
  assert.equal(customerPath, "customer/9d9edb77-245f.jpg");
  assert.equal(pharmacyPath, "pharmacy/9d9edb77-245f.jpg");
  assert.notEqual(customerPath, pharmacyPath, "a customer and a pharmacy sharing an id must not overwrite each other");
  assert.throws(() => buildMarketingEvidencePhotoPath({ entityId: "", entityType: "customer" }));

  // ── The write stores the bytes AND indexes them, in the bucket the table defaults to ──
  const stored = fakeSupabase();
  const storedPath = await storeMarketingEvidencePhoto({
    imageDataUrl: jpegDataUrl,
    record: {
      capturedAccuracyMeters: 12,
      capturedAddress: "PQGW+3GR, Radwan Mansour St, Faqous, Al-Sharqia",
      capturedAt: timestamp,
      capturedLatitude: 30.72513372,
      capturedLongitude: 31.79614512,
      entityId: "9d9edb77-245f-4ebe-8b26-da19f0a2b6d1",
      entityType: "customer",
      hasTimestamp: true,
      originalFileName: "customer-live-2026-08-02T14:05:20.772Z.jpg",
      uploadedByHrId: "A-10",
    },
    supabase: stored.client,
  });

  assert.equal(storedPath, "customer/9d9edb77-245f-4ebe-8b26-da19f0a2b6d1.jpg");
  assert.equal(stored.calls.uploaded.length, 1, "the image bytes must actually be uploaded");
  assert.equal(stored.calls.uploaded[0].bucket, MARKETING_EVIDENCE_BUCKET);
  assert.equal(stored.calls.uploaded[0].contentType, "image/jpeg");
  assert.equal(stored.calls.uploaded[0].size, 17);
  assert.equal(stored.calls.inserted.length, 1, "and indexed in marketing_evidence_files, which has stayed empty since it shipped");

  const row = stored.calls.inserted[0];
  assert.equal(
    row.storage_bucket,
    MARKETING_EVIDENCE_BUCKET,
    "bucket must match the column default, or the row points at a bucket the reader never looks in",
  );
  assert.equal(row.storage_path, storedPath, "the indexed path must be the path the bytes went to");
  assert.equal(row.entity_type, "customer");
  assert.equal(row.entity_id, "9d9edb77-245f-4ebe-8b26-da19f0a2b6d1");
  assert.equal(row.evidence_type, "location_photo");
  assert.equal(row.captured_latitude, 30.72513372, "the GPS fix must be carried onto the file row");
  assert.equal(row.captured_longitude, 31.79614512);
  assert.equal(row.captured_accuracy_meters, 12);
  assert.equal(row.captured_address, "PQGW+3GR, Radwan Mansour St, Faqous, Al-Sharqia");
  assert.equal(row.captured_at, timestamp);
  assert.equal(row.has_timestamp, true);
  assert.equal(row.content_type, "image/jpeg");
  assert.equal(row.original_file_name, "customer-live-2026-08-02T14:05:20.772Z.jpg");
  assert.equal(row.uploaded_by_hr_id, "A-10");

  // ── Neither half may survive alone ──
  const uploadFailed = fakeSupabase({ failUpload: true });
  await assert.rejects(
    storeMarketingEvidencePhoto({
      imageDataUrl: jpegDataUrl,
      record: {
        capturedAccuracyMeters: null, capturedAddress: null, capturedAt: null,
        capturedLatitude: null, capturedLongitude: null, entityId: "c-1",
        entityType: "customer", hasTimestamp: true, originalFileName: null, uploadedByHrId: null,
      },
      supabase: uploadFailed.client,
    }),
    /Unable to store the live capture photo/,
  );
  assert.equal(uploadFailed.calls.inserted.length, 0, "a failed upload must not leave an index row claiming a file exists");

  const indexFailed = fakeSupabase({ failInsert: true });
  await assert.rejects(
    storeMarketingEvidencePhoto({
      imageDataUrl: jpegDataUrl,
      record: {
        capturedAccuracyMeters: null, capturedAddress: null, capturedAt: null,
        capturedLatitude: null, capturedLongitude: null, entityId: "c-2",
        entityType: "customer", hasTimestamp: true, originalFileName: null, uploadedByHrId: null,
      },
      supabase: indexFailed.client,
    }),
    /Unable to record the live capture photo/,
  );
  assert.deepEqual(
    indexFailed.calls.removed,
    [["customer/c-2.jpg"]],
    "a failed index write must remove the orphaned object rather than leave an unreferenced shop-front photo in the bucket",
  );

  // ── The approver's read: a signed URL, never a public one ──
  const reader = fakeSupabase({ evidenceRow: { captured_at: timestamp, storage_path: "customer/c-9.jpg" } });
  const photo = await loadMarketingEvidencePhoto({
    entityId: "c-9",
    entityType: "customer",
    supabase: reader.client,
  });
  assert.ok(photo, "a customer with a stored evidence file must resolve to a viewable photo");
  assert.match(photo.signedUrl, /^https:\/\/signed\.example\/marketing-evidence\/customer\/c-9\.jpg/);
  assert.equal(
    photo.capturedAt,
    timestamp,
    "the capture time must come back with the image — an approver judging a shop front needs to know WHEN it was photographed",
  );
  assert.equal(reader.calls.signed[0].ttl, 3600, "signed URLs expire — an approval sitting, not a shareable link");

  // No stored file → null, so the approver is told nothing was retained rather than shown a name.
  const empty = fakeSupabase({ evidenceRow: null });
  assert.equal(
    await loadMarketingEvidencePhoto({ entityId: "c-none", entityType: "customer", supabase: empty.client }),
    null,
    "a customer whose photo was never stored must resolve to null, not to a filename posing as proof",
  );
  assert.equal(
    await loadMarketingEvidencePhoto({ entityId: null, entityType: "customer", supabase: empty.client }),
    null,
  );
  assert.equal(await createMarketingEvidencePhotoSignedUrl(null, empty.client), null);
}
