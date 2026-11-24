import assert from "node:assert/strict";

import { transcribeWithGroq } from "../src/lib/ai/groq-transcription.ts";
import { closeWebmTimelineGaps, isWebmRecording } from "../src/lib/ai/webm-timeline.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A voice note's timeline is repaired before the speech service measures it (24 Nov 2026).
//
// WHAT HAPPENED. A rep's 13-second CRM voice note was refused by the speech service with HTTP 413 —
// "Groq transcription failed: too_large" — although the file was 40 KB. Its first audio packet was
// stamped at 0 and every packet after it at 15,669 seconds onward: Chrome's recorder had stamped the rest
// on a clock that started four hours earlier. 18 of 30 recent stored notes had the same hole (4 seconds to
// 4 h 21 min); the service measures by those stamps, so the long ones are refused and the rest are billed
// at the length they claim.
//
// WHAT IS PINNED:
//   1. A hole between clusters is closed: the later cluster, the cue that points into it and the header's
//      duration all follow on by one ordinary frame — and the caller's array is never modified.
//   2. The same on Chrome's live shape — unknown-size Segment and Clusters, no cues, no duration.
//   3. A hole INSIDE one cluster (under 32 s fits a packet's own offset) is closed in the offsets.
//   4. A continuous recording, a non-WebM file and a truncated or garbage file come back as the SAME
//      array — the repair never guesses and never throws.
//   5. `transcribeWithGroq` sends the REPAIRED bytes, and sends a non-WebM recording byte for byte.
//
// The recordings are built here, byte by byte, rather than kept as fixtures: a real note is a rep's voice.
// ─────────────────────────────────────────────────────────────────────────────

const UNKNOWN = Symbol("unknown size");

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let rest = id; rest > 0; rest = Math.floor(rest / 256)) out.unshift(rest % 256);
  return out;
}

function el(id: number, body: number[] | number[][], size: number | typeof UNKNOWN = 0): number[] {
  const data = Array.isArray(body[0]) ? (body as number[][]).flat() : (body as number[]);
  const sizeBytes =
    size === UNKNOWN ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : [0x10, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff];
  return [...idBytes(id), ...sizeBytes, ...data];
}

function uint(value: number, width: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (let i = 0; i < width; i++) {
    out.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return out;
}

function float32(value: number): number[] {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return [...new Uint8Array(view.buffer)];
}

/** A SimpleBlock on track 1 at `relative` ms inside its cluster, with a few bytes standing for audio. */
function block(relative: number): number[] {
  return el(0xa3, [0x81, (relative >> 8) & 0xff, relative & 0xff, 0x80, 0xfc, 0xff, 0xfe]);
}

function cluster(timecode: number, relatives: number[], size: number | typeof UNKNOWN = 0): number[] {
  return el(0x1f43b675, [el(0xe7, uint(timecode, 4)), ...relatives.map(block)], size);
}

const HEADER = el(0x1a45dfa3, [el(0x4282, [0x77, 0x65, 0x62, 0x6d])]);
const TRACKS = el(0x1654ae6b, [el(0xae, [el(0xd7, [1]), el(0x86, [0x41, 0x5f, 0x4f, 0x50, 0x55, 0x53])])]);

/** The production shape: known sizes, an Info with a duration, and cues. */
function knownSizeRecording(): Uint8Array {
  const info = el(0x1549a966, [el(0x2ad7b1, uint(1_000_000, 3)), el(0x4489, float32(15_669_125))]);
  const cues = el(0x1c53bb6b, [
    el(0xbb, [el(0xb3, uint(0, 4)), el(0xb7, [el(0xf7, [1])])]),
    el(0xbb, [el(0xb3, uint(15_669_005, 4)), el(0xb7, [el(0xf7, [1])])]),
  ]);
  const segment = el(0x18538067, [info, TRACKS, cluster(0, [0]), cluster(15_669_005, [0, 60, 120]), cues]);
  return new Uint8Array([...HEADER, ...segment]);
}

type Parsed = { clusters: { time: number; relatives: number[] }[]; duration: number | null; cues: number[] };

/** Reads back exactly what the tests build — not a general parser. */
function parse(bytes: Uint8Array): Parsed {
  const out: Parsed = { clusters: [], duration: null, cues: [] };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hex = Buffer.from(bytes).toString("hex");
  for (let i = 0; i < bytes.length - 4; i++) {
    if (hex.startsWith("1f43b675", i * 2)) {
      const unknown = bytes[i + 4] === 0x01;
      const timeAt = i + 4 + (unknown ? 8 : 4) + 1 + 4;
      out.clusters.push({ time: view.getUint32(timeAt), relatives: [] });
    } else if (hex.startsWith("a310", i * 2) && bytes[i + 5] === 0x81) {
      out.clusters[out.clusters.length - 1]?.relatives.push(view.getInt16(i + 6));
    } else if (hex.startsWith("448910", i * 2)) {
      out.duration = view.getFloat32(i + 6);
    } else if (hex.startsWith("b310", i * 2)) {
      out.cues.push(view.getUint32(i + 5));
    }
  }
  return out;
}

export async function runWebmTimelineRepairTests() {
  // ── 1. A hole between clusters is closed, with its cue and the duration ────────
  {
    const input = knownSizeRecording();
    const before = Buffer.from(input).toString("hex");
    const before_ = parse(input);
    assert.deepEqual(before_.clusters.map((c) => c.time), [0, 15_669_005], "the fixture carries the production hole");

    const repaired = closeWebmTimelineGaps(input);
    const after = parse(repaired.bytes);
    assert.equal(Buffer.from(input).toString("hex"), before, "the caller's recording is never modified");
    assert.equal(repaired.bytes.length, input.length, "every rewrite is in place, so no element changes size");
    assert.deepEqual(after.clusters, [
      { time: 0, relatives: [0] },
      { time: 60, relatives: [0, 60, 120] },
    ], "the second cluster follows the first by one ordinary 60 ms frame, its packets' offsets unchanged");
    assert.deepEqual(after.cues, [0, 60], "a cue into the moved cluster moves with it");
    assert.equal(after.duration, 240, "the header's duration is the real length, not 4 h 21 min");
    assert.equal(repaired.closedMs, 15_668_945);
  }

  // ── 2. Chrome's live shape: unknown-size Segment and Clusters, no cues, no duration ──
  {
    const segment = el(0x18538067, [TRACKS, cluster(0, [0], UNKNOWN), cluster(479_630, [0, 20, 40], UNKNOWN)], UNKNOWN);
    const repaired = closeWebmTimelineGaps(new Uint8Array([...HEADER, ...segment]));
    assert.deepEqual(parse(repaired.bytes).clusters, [
      { time: 0, relatives: [0] },
      { time: 20, relatives: [0, 20, 40] },
    ], "an unknown-size cluster ends where the next cluster begins, and its hole is closed the same way");
  }

  // ── 3. A hole inside one cluster is closed in the packets' own offsets ─────────
  {
    const segment = el(0x18538067, [TRACKS, cluster(0, [0, 20, 25_800, 25_820]), cluster(25_840, [0, 20])]);
    const repaired = closeWebmTimelineGaps(new Uint8Array([...HEADER, ...segment]));
    assert.deepEqual(parse(repaired.bytes).clusters, [
      { time: 0, relatives: [0, 20, 40, 60] },
      { time: 80, relatives: [0, 20] },
    ], "the packets after a 25.8 s hole inside a cluster, and every later cluster, are pulled back by it");
  }

  // ── 4. What it must not touch comes back as the SAME array ─────────────────────
  {
    const continuous = new Uint8Array([...HEADER, ...el(0x18538067, [TRACKS, cluster(0, [0, 20, 40]), cluster(60, [0, 20])])]);
    const result = closeWebmTimelineGaps(continuous);
    assert.equal(result.bytes, continuous, "a continuous recording is returned as it came");
    assert.equal(result.closedMs, 0);

    const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    assert.equal(closeWebmTimelineGaps(mp4).bytes, mp4, "a Safari .m4a is not WebM and is returned as it came");

    const truncated = knownSizeRecording().slice(0, 120);
    assert.equal(closeWebmTimelineGaps(truncated).bytes, truncated, "a file it cannot read is returned, never thrown on");
    const garbage = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00]);
    assert.equal(closeWebmTimelineGaps(garbage).bytes, garbage);

    assert.equal(isWebmRecording("x.webm", "", mp4), true);
    assert.equal(isWebmRecording("x.m4a", "audio/mp4", mp4), false);
    assert.equal(isWebmRecording("x.bin", "", knownSizeRecording()), true, "recognised by its first four bytes");
  }

  // ── 5. The speech call sends the REPAIRED bytes ────────────────────────────────
  {
    const sent: Uint8Array[] = [];
    const realFetch = globalThis.fetch;
    const realKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "gsk_test_only";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const file = (init?.body as FormData).get("file") as Blob;
      sent.push(new Uint8Array(await file.arrayBuffer()));
      return new Response(JSON.stringify({ text: "الدكتور مهتم بالمنتج" }), { status: 200 });
    }) as typeof fetch;
    try {
      await transcribeWithGroq({
        audio: knownSizeRecording(),
        contentType: "audio/webm",
        filename: "8ef51ef4.webm",
        purpose: "crm_visit_comment",
      });
      assert.deepEqual(
        parse(sent[0]).clusters.map((c) => c.time),
        [0, 60],
        "the service is sent the 240 ms the recording really is, not the 4 h 21 min its stamps claimed",
      );

      const m4a = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 1, 2, 3]);
      await transcribeWithGroq({ audio: m4a, contentType: "audio/mp4", filename: "a.m4a", purpose: "crm_visit_comment" });
      assert.deepEqual([...sent[1]], [...m4a], "a non-WebM recording is sent byte for byte");
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = realKey;
    }
  }
}
