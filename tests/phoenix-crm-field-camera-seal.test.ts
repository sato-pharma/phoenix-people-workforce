import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { GOOGLE_ATTESTATION_ROOTS } from "../src/lib/phoenix-crm/field-camera/google-roots.ts";
import {
  FIELD_CAMERA_PACKAGE,
  FIELD_CAMERA_SIGNING_DIGEST,
  SEAL_ATTESTATION_CHALLENGE,
  hasSealTrailer,
  splitSealedFile,
} from "../src/lib/phoenix-crm/field-camera/seal-format.ts";
import {
  SEAL_NO_LOCATION,
  parseSealPayload,
  sealIntegrityProblems,
  sealLocationProblems,
  sealPayloadProblems,
  sealPayloadWarnings,
  type SealPayload,
} from "../src/lib/phoenix-crm/field-camera/seal-rules.ts";
import { RELEASE_IDENTITY, verifySealedPhoto, type SealIdentity } from "../src/lib/phoenix-crm/server/field-camera-seal.ts";

/**
 * Phoenix CRM — the Phoenix Camera's sealed photo (owner, 2026-11-20: a separate Android camera app that photographs
 * the place with no network and stamps the time, date and location — "take every precaution against fake locations
 * and fraud, and keep its seal").
 *
 * 1. The verifier, on files shaped exactly like the app's (tests/fixtures/field-camera, made by
 *    scripts/field-camera/make-seal-fixtures.mjs with TEST keys under a TEST root): a good file holds and names
 *    its seal id and phone key; a changed picture, a changed payload, a key outside the trusted roots (Google's
 *    alone in production), an unlocked phone, a key kept in software, another app, a re-signed copy of our app,
 *    another challenge and a key with no attestation are each refused, in words.
 * 2. The payload's rules, behaviourally: fake location, too few satellites, a stale fix, a reading too rough to
 *    stand, a photo older than 72 hours or later than now, and satellite time far from Phoenix's clock refuse;
 *    a drifted phone clock and USB debugging only warn.
 * 3. By source: production trusts Google's roots and our release identity only; a sealed file is judged BEFORE it
 *    is uploaded and is born captured with the seal's reading, closed to the rep; the browser sends it byte for
 *    byte; the migration ties a sealed row to its seal and lets one seal validate one customer.
 *
 * Break direction: skip the image hash and the changed-picture case passes through; trust any self-signed root and
 * the foreign-root case holds; drop the boot-state check and the unlocked case holds.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

type Fixtures = {
  rootPem: string;
  identity: SealIdentity;
  nowMs: number;
  files: Record<string, string>;
};

const fixtures = JSON.parse(readFileSync(new URL("tests/fixtures/field-camera/seal-fixtures.json", ROOT), "utf8")) as Fixtures;

function fileOf(name: string): Buffer {
  const base64 = fixtures.files[name];
  assert.ok(base64, `fixture ${name} exists`);
  return Buffer.from(base64, "base64");
}

function judge(bytes: Uint8Array, roots: readonly string[] = [fixtures.rootPem]) {
  return verifySealedPhoto(bytes, { rootsPem: roots, identity: fixtures.identity, nowMs: fixtures.nowMs });
}

function refusedWith(name: string, bytes: Uint8Array, words: RegExp, roots?: readonly string[]): void {
  const verdict = judge(bytes, roots);
  assert.equal(verdict.ok, false, `${name} is refused`);
  if (!verdict.ok) assert.match(verdict.problem, words, `${name}: ${verdict.problem}`);
}

function verifierHolds(): void {
  assert.deepEqual(fixtures.identity, {
    packageName: FIELD_CAMERA_PACKAGE,
    signingDigest: FIELD_CAMERA_SIGNING_DIGEST,
    challenge: SEAL_ATTESTATION_CHALLENGE,
  });

  const valid = fileOf("valid");
  assert.equal(hasSealTrailer(valid), true);
  const verdict = judge(valid);
  assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.problem);
  if (verdict.ok) {
    assert.match(verdict.sealId, /^[0-9a-f]{64}$/);
    assert.match(verdict.deviceKey, /^[0-9a-f]{64}$/);
    assert.equal(verdict.securityLevel, "TEE");
    assert.equal(verdict.serials.length, 2);
    assert.equal(verdict.payload.hrId, "B-182");
    assert.deepEqual(verdict.warnings, []);
  }

  const parts = splitSealedFile(valid);
  assert.ok(parts);
  assert.equal(hasSealTrailer(parts.image), false, "the picture alone carries no seal");
  assert.equal(splitSealedFile(valid.subarray(0, valid.length - 3)), null, "a cut-off file has no seal");
  refusedWith("a cut-off file", valid.subarray(0, valid.length - 3), /damaged or cut off/);

  // One changed byte of the picture.
  const changedPicture = Buffer.from(valid);
  changedPicture[10] ^= 0x01;
  refusedWith("a changed picture", changedPicture, /picture was changed/);

  // The payload's location moved, the signature kept.
  const sealText = parts.sealText;
  const seal = JSON.parse(sealText) as { payload: string };
  const moved = JSON.stringify({ ...JSON.parse(sealText), payload: seal.payload.replace('"lat":30.0131', '"lat":30.0999') });
  assert.notEqual(moved, sealText);
  const movedBytes = Buffer.from(moved, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(movedBytes.length);
  refusedWith("a changed payload", Buffer.concat([Buffer.from(parts.image), movedBytes, length, Buffer.from("PHXSEAL1")]), /signature does not match/);

  // The same good file, against Google's roots: our test root is not one of them.
  refusedWith("a key outside Google's roots", valid, /genuine phone's secure chip/, GOOGLE_ATTESTATION_ROOTS.map((root) => root.pem));

  refusedWith("an unlocked phone", fileOf("unlocked"), /unlocked or modified/);
  refusedWith("a key kept in software", fileOf("softwareKey"), /secure chip/);
  refusedWith("another app", fileOf("otherApp"), /not made by the Phoenix Camera/);
  refusedWith("a re-signed copy", fileOf("modifiedApp"), /modified copy/);
  refusedWith("another challenge", fileOf("otherChallenge"), /not made by the Phoenix Camera/);
  refusedWith("no attestation", fileOf("noAttestation"), /did not vouch/);
  refusedWith("a fake location", fileOf("mockLocation"), /fake-location app/);
  // Another app's genuine attested key signing a made-up leaf that claims to be ours: the chain verifies, so only
  // the "no KeyDescription above the leaf" rule stands between it and a pass.
  refusedWith("a leaf vouched for by another app's key", fileOf("forgedByAnotherAppsKey"), /another app's key/);

  // The seal id is the payload's own hash, so a re-signed copy of the same payload is the same seal.
  if (verdict.ok) {
    const payloadText = (JSON.parse(parts.sealText) as { payload: string }).payload;
    assert.equal(verdict.sealId, createHash("sha256").update(payloadText, "utf8").digest("hex"), "the seal id is the payload's hash");
  }

  // A good seal grows stale: 73 hours after it was taken.
  const stale = verifySealedPhoto(valid, { rootsPem: [fixtures.rootPem], identity: fixtures.identity, nowMs: fixtures.nowMs + 72 * 3_600_000 });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.problem, /72 hours/);

  // Production's identity is ours, and Google's two roots are the only anchors it ships.
  assert.deepEqual(RELEASE_IDENTITY, fixtures.identity);
  assert.equal(GOOGLE_ATTESTATION_ROOTS.length, 2);
}

function payloadRulesBehave(): void {
  const base = JSON.parse(JSON.parse(splitSealedFile(fileOf("valid"))!.sealText).payload) as Record<string, unknown>;
  const now = fixtures.nowMs;
  const payloadOf = (overrides: Record<string, unknown>): SealPayload => {
    const parsed = parseSealPayload(JSON.stringify({ ...base, ...overrides }));
    assert.equal(typeof parsed, "object", `parses: ${String(parsed)}`);
    return parsed as SealPayload;
  };
  const problems = (overrides: Record<string, unknown>) => sealPayloadProblems(payloadOf(overrides), now);

  assert.deepEqual(problems({}), []);
  assert.match(problems({ mock: true })[0], /fake-location app/);
  assert.match(problems({ mockAppActive: true })[0], /fake-location app was switched on/);
  assert.match(problems({ rooted: true })[0], /rooted/);
  assert.match(problems({ emulator: true })[0], /real phone/);
  // The rep never waits for the satellites: the phone's combined position stands beside the satellites alone.
  assert.deepEqual(problems({ provider: "fused", satellitesUsed: 0 }), []);
  assert.deepEqual(problems({ provider: "network", satellitesUsed: 0 }), []);
  assert.match(problems({ provider: "passive" })[0], /own location service/);
  assert.match(problems({ timeSource: "guess" })[0], /which clock/);
  assert.deepEqual(problems({ timeSource: "phoenix" }), []);
  assert.deepEqual(problems({ timeSource: "phone", networkTimeUtc: null }), []);
  // Four satellites are asked of a position from the satellites alone, and only of one.
  assert.match(problems({ satellitesUsed: 3 })[0], /at least 4/);
  assert.deepEqual(problems({ satellitesUsed: 4 }), []);
  // Ten minutes either side of the shutter (owner, 20 Nov 2026, point 3): the photo is taken at once, sealed with the
  // closest good position from the ten minutes before, else the first one in the ten minutes after.
  assert.deepEqual(problems({ fixAgeMs: 600_000 }), []);
  assert.match(problems({ fixAgeMs: 600_001 })[0], /more than 10 minutes before the photo/);
  assert.deepEqual(problems({ fixAgeMs: -600_000 }), []);
  assert.match(problems({ fixAgeMs: -600_001 })[0], /more than 10 minutes after the photo/);

  // "No location" is still a seal: it parses, carries no numbers, and says so in its location problems only.
  const noFix = payloadOf({ locationStatus: "none", lat: null, lon: null, accuracyMeters: null, satellitesUsed: null, satellitesSeen: null, fixAgeMs: null, provider: null });
  assert.equal(noFix.lat, null);
  assert.equal(noFix.locationStatus, "none");
  assert.deepEqual(sealIntegrityProblems(noFix, now), [], "no position is not a fraud signal");
  assert.deepEqual(sealLocationProblems(noFix), [SEAL_NO_LOCATION]);
  assert.deepEqual(sealPayloadProblems(noFix, now), [SEAL_NO_LOCATION], "the Super Admin's upload still refuses it");
  assert.equal(typeof parseSealPayload(JSON.stringify({ ...base, locationStatus: "none" })), "string", "a seal saying none with numbers is refused");
  assert.equal(typeof parseSealPayload(JSON.stringify({ ...base, locationStatus: "nowhere" })), "string", "an unknown location status is refused");
  assert.equal(payloadOf({}).locationStatus, "locked", "a seal from before camera 2.1.0 reads as locked");
  assert.equal(payloadOf({ locationStatus: "late", fixAgeMs: -120_000 }).locationStatus, "late");
  // The camera's sync splits the two: a fake-location app is red, a rough position only keeps it from being a place.
  assert.match(sealIntegrityProblems(payloadOf({ mock: true }), now)[0], /fake-location app/);
  assert.deepEqual(sealLocationProblems(payloadOf({ mock: true })), []);
  assert.deepEqual(sealIntegrityProblems(payloadOf({ accuracyMeters: 41 }), now), []);
  assert.match(sealLocationProblems(payloadOf({ accuracyMeters: 41 }))[0], /98% sure/);
  // The owner's "at least 98% accurate": 40 m (Android's 68% radius) is 98% within 74 m; one metre more refuses.
  assert.deepEqual(problems({ accuracyMeters: 40 }), []);
  assert.match(problems({ accuracyMeters: 41 })[0], /98% sure of the place only to 76 m, and 74 m is the most accepted/);
  // The satellites' and Phoenix's clocks are compared only when the time is the satellites'.
  assert.deepEqual(problems({ timeSource: "phoenix", networkTimeUtc: "2026-11-20T09:40:00.000Z" }), []);
  assert.ok(problems({ accuracyMeters: 400 }).length > 0, "a reading rougher than the validated place's line refuses");
  assert.ok(problems({ lat: 0, lon: 0 }).length > 0, "0,0 refuses");
  assert.match(problems({ takenAtUtc: new Date(now + 10 * 60_000).toISOString() })[0], /later than now/);
  assert.match(problems({ takenAtUtc: new Date(now - 73 * 3_600_000).toISOString() })[0], /72 hours/);
  assert.match(problems({ networkTimeUtc: "2026-11-20T09:40:00.000Z" })[0], /disagreed/);
  assert.deepEqual(problems({ networkTimeUtc: null }), []);

  assert.equal(typeof parseSealPayload("{}"), "string", "an empty payload is refused in words");
  assert.equal(typeof parseSealPayload(JSON.stringify({ ...base, app: "com.example.fakecamera" })), "string");

  assert.deepEqual(sealPayloadWarnings(payloadOf({})), []);
  const warnings = sealPayloadWarnings(payloadOf({ phoneClockUtc: "2026-11-20T09:50:00.000Z", networkTimeUtc: null, developerOptions: true, adb: true }));
  assert.equal(warnings.length, 4);
  assert.match(warnings.join(" "), /clock was 10 minutes off/);
  // A position over a minute old is never silent: the Super Admin reads its age beside the photo.
  assert.deepEqual(sealPayloadWarnings(payloadOf({ fixAgeMs: 60_000 })), []);
  assert.deepEqual(sealPayloadWarnings(payloadOf({ fixAgeMs: -20_000 })), [], "a location locked just after the shutter is the normal case");
  const old = sealPayloadWarnings(payloadOf({ fixAgeMs: 110_000 }));
  assert.equal(old.length, 1);
  assert.match(old[0], /taken 2 minutes before the photo/);
  // The phone's own clock is the last resort, and the Super Admin is told when it was the one used.
  const phoneTime = sealPayloadWarnings(payloadOf({ timeSource: "phone", networkTimeUtc: null, phoneClockUtc: "2026-11-20T09:50:00.000Z" }));
  assert.equal(phoneTime.length, 1);
  assert.match(phoneTime[0], /phone's own clock/);
  assert.match(sealPayloadWarnings(payloadOf({ timeSource: "phoenix", phoneClockUtc: "2026-11-20T09:50:00.000Z" }))[0], /off Phoenix's time/);
}

// Camera 2.0, the rep's offline visit app (owner, 20 Nov 2026): the signed visit block names the territory, the
// customer, the visit's own id and the offline clock, so nothing the phone sends beside the photo can move them.
function visitBlockBehaves(): void {
  const base = JSON.parse(JSON.parse(splitSealedFile(fileOf("valid"))!.sealText).payload) as Record<string, unknown>;
  const parse = (visit: unknown) => parseSealPayload(JSON.stringify({ ...base, visit }));
  const customerId = "0b1e8a52-7c1f-4f3e-9d5a-2a4b6c8d0e1f";
  const visitId = "6f2d9c41-3b7a-4e8f-a1c2-d3e4f5a6b7c8";
  const anchorId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

  const none = parseSealPayload(JSON.stringify(base));
  assert.equal(typeof none, "object");
  assert.equal((none as SealPayload).visit, null, "a photo taken for the Super Admin's upload carries no visit");

  const online = parse({ seatId: " PED-CAI-01 ", customerId: customerId.toUpperCase(), visitId });
  assert.equal(typeof online, "object", String(online));
  assert.deepEqual((online as SealPayload).visit, {
    seatId: "PED-CAI-01",
    customerId,
    visitId,
    offline: null,
    intent: "visit",
    photoKind: "place",
    newCustomer: null,
  });

  // Camera 2.1.0 names which of the four doctor's-name photos it is; camera 2.2.0 a validation alone or a new customer.
  const doorSign = parse({ seatId: "PED-CAI-01", customerId, visitId, photoKind: "door_sign", intent: "validate" });
  assert.equal((doorSign as SealPayload).visit?.photoKind, "door_sign");
  assert.equal((doorSign as SealPayload).visit?.intent, "validate");
  assert.equal(typeof parse({ seatId: "PED-CAI-01", customerId, visitId, photoKind: "selfie" }), "string", "an unknown photo kind is refused");
  assert.equal(typeof parse({ seatId: "PED-CAI-01", customerId, visitId, intent: "delete" }), "string", "an unknown intent is refused");
  const newCustomer = { listType: "AM", name: "Dr Ahmed Samir Fawzy", nameParts: { first: "Ahmed", middle: "Samir", last: "Fawzy" }, customerType: "Clinic", speciality: "Pediatrics", proposedGrade: "b", phone: null };
  const added = parse({ seatId: "PED-CAI-01", customerId, visitId, intent: "new_customer", newCustomer });
  assert.equal(typeof added, "object", String(added));
  assert.equal((added as SealPayload).visit?.newCustomer?.proposedGrade, "B");
  assert.deepEqual((added as SealPayload).visit?.newCustomer?.nameParts, { first: "Ahmed", middle: "Samir", last: "Fawzy" });
  assert.equal(typeof parse({ seatId: "PED-CAI-01", customerId, visitId, intent: "new_customer" }), "string", "a new customer with no details is refused");
  assert.equal(typeof parse({ seatId: "PED-CAI-01", customerId, visitId, newCustomer }), "string", "details on a plain visit are refused");

  const offline = parse({ seatId: "PED-CAI-01", customerId, visitId, offline: { anchorId, elapsedMs: 3_600_000.4, bootId: "42" } });
  assert.deepEqual((offline as SealPayload).visit?.offline, { anchorId, elapsedMs: 3_600_000, bootId: "42" });

  assert.equal(typeof parse("visit"), "string", "a visit that is not an object is refused");
  assert.equal(typeof parse({ seatId: "PED-CAI-01", customerId: "not-a-uuid", visitId }), "string", "a customer that is not an id is refused");
  assert.equal(typeof parse({ seatId: "PED-CAI-01", customerId, visitId: "1" }), "string", "a visit id that is not a uuid is refused");
  assert.equal(typeof parse({ seatId: "", customerId, visitId }), "string", "a visit with no territory is refused");
  assert.equal(typeof parse({ seatId: "PED-CAI-01", customerId, visitId, offline: { anchorId, elapsedMs: -1 } }), "string", "a negative uptime is refused");
  assert.equal(typeof parse({ seatId: "PED-CAI-01", customerId, visitId, offline: { anchorId: "x", elapsedMs: 5 } }), "string", "an anchor that is not an id is refused");
}

function syncWiringHolds(): void {
  // What the sync does with an item (record it at once or keep it for the Super Admin, never refuse it) is pinned
  // by tests/phoenix-crm-camera-items.test.ts since camera 2.1 (owner, 20 Nov 2026). The seal half stays here.
  const camera = read("src/lib/phoenix-crm/server/field-camera.ts");
  assert.match(camera, /allowResend/, "the used-seal check knows a resend");

  const service = read("src/lib/phoenix-crm/server/admin-photo.ts");
  const rep = service.slice(service.indexOf("export async function validateWithRepSeal("));
  assert.ok(rep.length > 0 && rep.indexOf("blockedReasonFor(") > 0, "the rep's sealed validation passes the same door as every validation");
  assert.ok(rep.indexOf("uploadPhotoBytesForSlot(") > 0, "the sealed picture itself is the validated photo");

  for (const path of ["app/api/phoenix-crm/field-camera/pack/route.ts", "app/api/phoenix-crm/field-camera/sync/route.ts"]) {
    const route = read(path);
    assert.match(route, /assertPermission\(access, "phoenix_crm", "create"\)/, `${path} is gated like entering a visit`);
    assert.match(route, /captureClientOf\(request\.headers\)/, `${path} asks which client is calling`);
  }
  const syncRoute = read("app/api/phoenix-crm/field-camera/sync/route.ts");
  assert.ok(syncRoute.indexOf("assertSameOriginMutation(request)") < syncRoute.indexOf("resolveAccessContext(request)"), "the sync checks its origin first");
}

function wiringHolds(): void {
  const server = read("src/lib/phoenix-crm/server/field-camera.ts");
  assert.match(server, /rootsPem: GOOGLE_ATTESTATION_ROOTS\.map\(\(root\) => root\.pem\)/, "production trusts Google's roots only");
  assert.match(server, /identity: RELEASE_IDENTITY/, "production asks for our release identity");
  assert.match(server, /\.eq\("seal_id", verdict\.sealId\)/, "a used seal is refused");
  assert.match(server, /android\.googleapis\.com\/attestation\/status/, "Google's revocation list is read");
  // The place is created in the seal's person's name (created_by_hr_id = rep_hr_id), so it must be the territory's rep.
  assert.match(
    server,
    /if \(occupant && !occupants\.includes\(payload\.hrId\)\) \{\s*throw validationError\([\s\S]{0,400}"phoenix_crm_admin_photo_seal_not_rep"/,
    "a seal naming anyone but the territory's rep is refused",
  );
  assert.match(server, /if \(!occupant\) \{\s*throw validationError\([\s\S]{0,200}"phoenix_crm_admin_photo_seal_not_rep"/, "a vacant territory refuses a seal");
  assert.match(server, /if \(!revocation\) \{\s*throw validationError\(/, "an unread revocation list with no last copy refuses");
  assert.match(read("src/lib/phoenix-crm/server/admin-photo.ts"), /occupantHrIds: seatOccupants\(seat\)/, "every occupant of the seat is asked");

  const service = read("src/lib/phoenix-crm/server/admin-photo.ts");
  const judged = service.indexOf("await checkFieldCameraPhoto(bytes");
  const uploaded = service.indexOf("await uploadPhotoBytesForSlot(");
  assert.ok(judged > 0 && uploaded > judged, "a sealed file is judged before anything is uploaded");
  assert.match(service, /status: "captured",[\s\S]{0,200}watch_until: new Date\(\)\.toISOString\(\),[\s\S]{0,80}rep_source: "sealed_photo"/);
  assert.equal(service.split('.eq("rep_source", "live")').length - 1, 2, "the rep's ask list and send touch live watches only");
  assert.match(service, /watch\.repSource === "sealed_photo"[\s\S]{0,40}throw conflictError/, "a sealed watch is never re-watched");

  const screen = read("src/components/phoenix-crm/admin-photo-screen.tsx");
  assert.match(screen, /hasSealTrailer\(bytes\)/);
  assert.ok(screen.indexOf("sealedPhotoAsDataUrl(file)") < screen.indexOf("photoAsJpeg(file)"), "a sealed file is never shrunk");

  const format = read("src/lib/phoenix-crm/field-camera/seal-format.ts");
  assert.doesNotMatch(format, /from "node:/, "the format half is safe in the browser");

  const migration = read("supabase/migrations/20261120134508_phoenix_crm_admin_photo_sealed_camera.sql");
  assert.match(migration, /rep_source in \('live', 'sealed_photo'\)/);
  assert.match(migration, /\(rep_source = 'sealed_photo'\) = \(seal_id is not null\)/);
  assert.match(migration, /create unique index if not exists phoenix_crm_admin_photo_validations_seal_idx[\s\S]*where seal_id is not null and status <> 'cancelled'/);
}

export function runPhoenixCrmFieldCameraSealTests(): void {
  verifierHolds();
  payloadRulesBehave();
  visitBlockBehaves();
  wiringHolds();
  syncWiringHolds();
}
