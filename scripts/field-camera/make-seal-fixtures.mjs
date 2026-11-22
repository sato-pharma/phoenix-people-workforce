#!/usr/bin/env node
/**
 * Builds tests/fixtures/field-camera/seal-fixtures.json — sealed files shaped EXACTLY like the Phoenix Camera's,
 * signed by keys made here and chained to a TEST root made here, so the verifier's every refusal can be proven
 * without a phone. Google's roots never appear: the test passes the test root as the only anchor, and a separate
 * case proves the same file is refused against Google's.
 *
 * Every private key lives in a temporary folder that is deleted before this exits; only certificates and signed
 * files are written. Needs `openssl` on PATH (Git for Windows ships it).
 *
 *   node scripts/field-camera/make-seal-fixtures.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash, createSign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refuseArguments } from "../lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "field-camera/make-seal-fixtures",
  usage: `make-seal-fixtures: rebuild tests/fixtures/field-camera/seal-fixtures.json from fresh TEST keys.

  node scripts/field-camera/make-seal-fixtures.mjs      rebuild the fixtures
  node scripts/field-camera/make-seal-fixtures.mjs -h   this text

It takes no arguments and has no dry run: every run makes new keys, so the whole file changes.`,
  hints: ["to see the cases without writing, read tests/fixtures/field-camera/seal-fixtures.json"],
});

const PACKAGE = "com.satopharma.phoenixcamera";
const DIGEST = "4417e26fb1a41c4d374297f305f043edeee00e11c55a14bd5ae69fff1ff1f4f1";
const CHALLENGE = "PHOENIX-CAMERA-SEAL-V1";
const TAKEN_AT = "2026-11-20T10:00:00.000Z";
const NOW_MS = Date.parse("2026-11-20T11:00:00.000Z");

const work = mkdtempSync(join(tmpdir(), "phx-seal-"));
const env = { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };
const openssl = (...args) => execFileSync("openssl", args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });

// ── DER encoding, just enough for Android's KeyDescription ───────────────────────────────────────────────────
function lengthBytes(n) {
  if (n < 0x80) return [n];
  const out = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}
const tlv = (id, body) => Buffer.concat([Buffer.from([...id, ...lengthBytes(body.length)]), body]);
const int = (n) => tlv([0x02], Buffer.from(n < 0x80 ? [n] : [0x00, n]));
const enumerated = (n) => tlv([0x0a], Buffer.from([n]));
const octets = (buf) => tlv([0x04], Buffer.from(buf));
const bool = (b) => tlv([0x01], Buffer.from([b ? 0xff : 0x00]));
const seq = (...parts) => tlv([0x30], Buffer.concat(parts));
const set = (...parts) => tlv([0x31], Buffer.concat(parts));
function contextTag(n) {
  if (n < 31) return [0xa0 | n];
  const digits = [];
  let rest = n;
  digits.unshift(rest & 0x7f);
  rest >>= 7;
  while (rest > 0) {
    digits.unshift(0x80 | (rest & 0x7f));
    rest >>= 7;
  }
  return [0xbf, ...digits];
}
const explicit = (n, inner) => tlv(contextTag(n), inner);

function keyDescription({ securityLevel = 1, locked = true, bootState = 0, packageName = PACKAGE, digest = DIGEST, challenge = CHALLENGE }) {
  const applicationId = seq(set(seq(octets(Buffer.from(packageName)), int(1))), set(octets(Buffer.from(digest, "hex"))));
  const software = seq(explicit(709, octets(applicationId)));
  const hardware = seq(explicit(704, seq(octets(Buffer.alloc(32, 7)), bool(locked), enumerated(bootState), octets(Buffer.alloc(32, 9)))));
  return seq(int(4), enumerated(securityLevel), int(41), enumerated(securityLevel), octets(Buffer.from(challenge)), octets(Buffer.alloc(0)), software, hardware);
}

// ── The test root and one leaf per case ───────────────────────────────────────────────────────────────────────
openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "root.key");
writeFileSync(join(work, "root.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign\n");
openssl("req", "-x509", "-new", "-key", "root.key", "-sha256", "-days", "3650", "-subj", "/CN=Phoenix Seal TEST root", "-config", "root.cnf", "-extensions", "ca", "-out", "root.pem");
const rootPem = readFileSync(join(work, "root.pem"), "utf8").trim();
const derOf = (pemFile) => Buffer.from(readFileSync(join(work, pemFile), "utf8").replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");

// `issuer` is the root unless named: the forged case signs a leaf with ANOTHER app's genuine attested key.
function leaf(name, description, issuer = "root", subject = "/CN=Android Keystore Key") {
  openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
  openssl("req", "-new", "-key", `${name}.key`, "-subj", subject, "-out", `${name}.csr`);
  const ext = description ? `1.3.6.1.4.1.11129.2.1.17=DER:${description.toString("hex")}\n` : "basicConstraints=CA:false\n";
  writeFileSync(join(work, `${name}.ext`), ext);
  openssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`, "-CAcreateserial", "-days", "3650", "-sha256", "-extfile", `${name}.ext`, "-out", `${name}.pem`);
  return { key: readFileSync(join(work, `${name}.key`), "utf8"), der: derOf(`${name}.pem`) };
}

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("A PHOENIX CAMERA TEST PICTURE"), Buffer.from([0xff, 0xd9])]);

function payloadFor(overrides = {}) {
  return {
    v: 1,
    app: PACKAGE,
    appVersion: "1.0.0",
    imageSha256: createHash("sha256").update(jpeg).digest("hex"),
    hrId: "B-182",
    repName: "Test Rep",
    lat: 30.0131,
    lon: 31.2089,
    accuracyMeters: 9.5,
    satellitesUsed: 11,
    satellitesSeen: 19,
    provider: "gps",
    fixAgeMs: 900,
    takenAtUtc: TAKEN_AT,
    timeSource: "satellites",
    phoneClockUtc: TAKEN_AT,
    networkTimeUtc: "2026-11-20T10:00:04.000Z",
    mock: false,
    mockAppActive: false,
    rooted: false,
    emulator: false,
    developerOptions: false,
    adb: false,
    deviceModel: "samsung SM-A155F",
    androidSdk: 34,
    nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    ...overrides,
  };
}

function sealed(leafCert, payloadObject, between = []) {
  const payload = JSON.stringify(payloadObject);
  const sig = createSign("SHA256").update(payload, "utf8").sign(leafCert.key).toString("base64");
  const seal = Buffer.from(JSON.stringify({ v: 1, payload, sig, chain: [leafCert.der.toString("base64"), ...between.map((cert) => cert.der.toString("base64")), derOf("root.pem").toString("base64")] }), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(seal.length);
  return Buffer.concat([jpeg, seal, length, Buffer.from("PHXSEAL1")]).toString("base64");
}

try {
  const good = leaf("good", keyDescription({}));
  const files = {
    valid: sealed(good, payloadFor()),
    mockLocation: sealed(good, payloadFor({ mock: true })),
    unlocked: sealed(leaf("unlocked", keyDescription({ locked: false, bootState: 2 })), payloadFor()),
    softwareKey: sealed(leaf("software", keyDescription({ securityLevel: 0 })), payloadFor()),
    otherApp: sealed(leaf("other", keyDescription({ packageName: "com.example.fakecamera" })), payloadFor()),
    modifiedApp: sealed(leaf("modified", keyDescription({ digest: "00".repeat(32) })), payloadFor()),
    otherChallenge: sealed(leaf("challenge", keyDescription({ challenge: "SOMETHING-ELSE" })), payloadFor()),
    noAttestation: sealed(leaf("bare", null), payloadFor()),
  };
  // The forgery the 20 Nov security review proved: any app's genuine attested key (C1, chained to the root) signs a
  // made-up leaf (C2) claiming to be the Phoenix Camera. C1 is no CA and carries its own KeyDescription.
  const otherAppsKey = leaf("c1", keyDescription({ packageName: "com.example.anyapp", challenge: "ANY" }), "root", "/CN=Android Keystore Key C1");
  files.forgedByAnotherAppsKey = sealed(leaf("c2", keyDescription({}), "c1"), payloadFor(), [otherAppsKey]);
  const out = new URL("../../tests/fixtures/field-camera/", import.meta.url);
  mkdirSync(out, { recursive: true });
  writeFileSync(
    new URL("seal-fixtures.json", out),
    `${JSON.stringify({ note: "Made by scripts/field-camera/make-seal-fixtures.mjs — TEST keys and a TEST root only.", rootPem, identity: { packageName: PACKAGE, signingDigest: DIGEST, challenge: CHALLENGE }, nowMs: NOW_MS, files }, null, 2)}\n`,
  );
  console.log(`wrote ${Object.keys(files).length} sealed files`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
