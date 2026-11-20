# The Phoenix Camera — sealed offline photos for "Validate with my photo"

Owner, 20 Nov 2026: a separate Android camera app, not part of Phoenix, that photographs the place with the time,
date and location, works in a clinic with no network, and is sent to the System Administrator on a call — "I'll
build my own, but you must take every precaution against fake locations and fraud, and keep its seal".

## The two halves

| Half | Where | What it does |
| --- | --- | --- |
| The camera | `sato-pharma/phoenix-field-camera` (private; a separate repository, never under `mobile/`) | Live camera only, the satellites' fix and time, a stamp burned into the picture, and a seal signed by a key held in the phone's secure chip. Built and signed by that repository's `build` workflow. |
| The verifier | `src/lib/phoenix-crm/field-camera/` (the browser-safe format and the payload rules), `src/lib/phoenix-crm/server/field-camera-seal.ts` (the signature and the phone's chain) and `src/lib/phoenix-crm/server/field-camera.ts` | Reads the seal from the uploaded file and decides whether it may stand in for the rep's live reading. |

## The file

`JPEG | seal JSON | uint32 big-endian length of the seal JSON | "PHXSEAL1"` — a viewer stops at the JPEG's end,
so the file still opens as a photo. The seal JSON is `{v, payload, sig, chain}`: the payload is JSON text naming
the JPEG's SHA-256, the rep, the fix, the satellites, the three clocks and the phone's own checks; `sig` is
ECDSA-SHA256 over the payload's bytes; `chain` is the Android key attestation chain, leaf first.

The rep sends it on WhatsApp as a **Document** (the app shares it as `application/octet-stream`), because a photo
sent as a photo is re-compressed and its seal is gone.

## What Phoenix refuses, and the trick each refusal stops

| Refusal | Trick |
| --- | --- |
| A changed byte in the picture or the stamp | editing the photo or its stamp |
| A signature not made by the attested key | a seal copied from another photo |
| A chain not ending at Google's attestation roots, or a revoked certificate | a key made outside a real phone |
| A software-only key, an unlocked or unverified boot | a modified phone that can sign anything |
| Another package or another signing certificate (`FIELD_CAMERA_SIGNING_DIGEST`) | a look-alike app |
| A fix marked mock, or a fake-location app switched on | a fake-location app |
| Root, an emulator | a phone that can lie about everything |
| A fix not from the satellites, fewer than 4 satellites, older than 10 minutes | a Wi-Fi or network position, a fix from memory |
| The satellites' time more than 10 minutes off Phoenix's clock (when the phone last read it) | a spoofed satellite signal |
| Older than 72 hours, or in the future | a photo kept for later |
| A seal already used (`seal_id`, partial unique index ignoring cancelled watches) | one photo for two customers |

Developer options, USB debugging, the phone's own clock, the absence of a Phoenix clock reading and a position
taken more than a minute before the photo are **warnings**: shown to the Super Admin, deciding nothing.

### Inside a building: the position from the door

Owner, 20 Nov 2026: *"they're going to capture the pictures inside of buildings, inside of polyclinics"*. The
satellites rarely reach inside, and the camera never falls back to a Wi-Fi or network position. From version
1.1.0 the camera **holds** its newest good satellite position (4+ satellites, within 150 m, not mocked, still
live when held) for 9 minutes, so the rep takes it at the door or outside and walks in. The seal's `fixAgeMs` is
the position's true age at the shutter and `satellitesUsed` the satellites that fixed it; the stamp adds
"Position from the door". Phoenix accepts up to `SEAL_MAX_FIX_AGE_MS` (10 minutes, a minute of margin over the
camera's hold) and, past `SEAL_DOOR_FIX_NOTE_MS` (a minute), tells the Super Admin the position's age beside the
photo. Switching Location off or a mocked fix drops the held position at once. A 1.0.x seal is unchanged: its
positions are never more than a minute old.

`checkFieldCameraPhoto` runs **before** the photo is stored. A passing seal creates the watch already captured,
with `rep_source = 'sealed_photo'`, the seal's fix in the `rep_*` columns and `seal_report` (no photo bytes, no
key); `phoenix_crm_validate_with_admin_photo` then validates it exactly as a live one, still under the 250 m
reading rule. The live path reads only `rep_source = 'live'` watches.

## The signing key

PKCS12 at `C:/Users/satoh/.phoenix-secrets/phoenix-camera/` with a copy in `F:/Phoenix Secrets Backup/phoenix-camera/`;
in the camera repository it lives only in the secrets `PHOENIX_CAMERA_KEYSTORE_BASE64` and
`PHOENIX_CAMERA_STORE_PASSWORD`. The certificate's SHA-256 is `FIELD_CAMERA_SIGNING_DIGEST`. A new key means
a new digest in Phoenix in the same change, and every phone reinstalling the app. Losing the key means the same.

## Tests

`tests/phoenix-crm-field-camera-seal.test.ts`, with fixtures from `scripts/field-camera/make-seal-fixtures.mjs`
(openssl; its private keys are made in a temporary folder that is deleted on exit, and only certificates and
signed files are kept).
