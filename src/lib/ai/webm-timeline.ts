/**
 * Closing the hole in a browser recording's timeline before the speech service measures it.
 *
 * WHAT IS WRONG WITH THE FILE. Chrome's `MediaRecorder` often stamps the FIRST audio packet at 0 and every
 * packet after it on a clock that started long before — the microphone track's own capture clock. The
 * result is a WebM whose audio is a few seconds long while its timestamps claim minutes or hours: measured
 * on production 24 Nov 2026, 18 of 30 recent CRM voice notes jumped from 0 to somewhere between 4 seconds
 * and 4 h 21 min after the first packet, and every one of them had the Chrome muxer's signature. Nothing
 * on the phone shows it — the rep hears his own few seconds — and nothing is lost, because every packet is
 * there; only the stamps are wrong.
 *
 * WHY IT MATTERS HERE. The speech service measures a recording by its timestamps, not by its packets. A
 * 40 KB, 13-second note stamped as 15,682 seconds was refused outright with HTTP 413 (24 Nov 2026 20:52
 * Cairo — "Groq transcription failed: too_large"), and the shorter holes were accepted and BILLED at the
 * length they claim, out of an hourly allowance a single fake hour can empty.
 *
 * WHAT THIS DOES. It walks the WebM's own structure and, wherever one packet follows the previous one by
 * more than `GAP_THRESHOLD_MS`, pulls that packet and everything after it back so it follows on by one
 * ordinary frame. Every rewrite is IN PLACE at the same byte width — a cluster's start time, a packet's
 * offset inside its cluster, a cue's time and the header's duration — so no element changes size and no
 * offset elsewhere in the file moves. Audio bytes are never touched. A continuous recording has no such
 * hole (the encoder emits a frame every 20–60 ms even over silence), so a sound file comes back unchanged.
 *
 * WHAT IT NEVER DOES. It never throws and never returns something it is unsure of: anything it cannot
 * parse, or a rewrite that would not fit its field, returns the ORIGINAL bytes untouched — the speech
 * service then answers exactly as it did before this existed. The input array is never modified.
 */

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
} as const;

/** The elements that can only sit directly under the Segment — the end of an unknown-size Cluster. */
const SEGMENT_CHILDREN = new Set([
  0x114d9b74, // SeekHead
  ID.info,
  0x1654ae6b, // Tracks
  ID.cluster,
  ID.cues,
  0x1043a770, // Chapters
  0x1254c367, // Tags
  0x1941a469, // Attachments
]);

/** A real recording never pauses this long between packets; a hole this size is a clock, not speech. */
const GAP_THRESHOLD_MS = 1_000;

/** The step a closed hole is given when the recording shows no ordinary step of its own. */
const FALLBACK_FRAME_MS = 20;

export type WebmTimelineRepair = {
  bytes: Uint8Array;
  /** How much false time was taken out, in milliseconds. 0 when the file came back as it was. */
  closedMs: number;
};

type Vint = { value: number; length: number; unknown: boolean };

class Unparseable extends Error {}

function readId(bytes: Uint8Array, offset: number): Vint {
  const first = bytes[offset];
  if (first === undefined || first === 0) throw new Unparseable("bad id");
  let length = 1;
  for (let mask = 0x80; length <= 4 && !(first & mask); mask >>= 1) length++;
  if (length > 4 || offset + length > bytes.length) throw new Unparseable("bad id length");
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i];
  return { value, length, unknown: false };
}

function readSize(bytes: Uint8Array, offset: number): Vint {
  const first = bytes[offset];
  if (first === undefined || first === 0) throw new Unparseable("bad size");
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 8 || offset + length > bytes.length) throw new Unparseable("bad size length");
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i];
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  return { value, length, unknown: allOnes };
}

type Element = { id: number; start: number; dataStart: number; end: number; unknown: boolean };

/** The elements between `start` and `end`. An unknown-size child runs to the end, except a Cluster. */
function children(bytes: Uint8Array, start: number, end: number): Element[] {
  const out: Element[] = [];
  let offset = start;
  while (offset < end) {
    const id = readId(bytes, offset);
    const size = readSize(bytes, offset + id.length);
    const dataStart = offset + id.length + size.length;
    let elementEnd = size.unknown ? end : dataStart + size.value;
    if (elementEnd > end) {
      // A recording cut short mid-element: keep what is there rather than refuse the whole file.
      elementEnd = end;
    }
    if (size.unknown && id.value === ID.cluster) {
      // An unknown-size Cluster holds packets until the next element that can only be the Segment's.
      let inner = dataStart;
      while (inner < end) {
        const childId = readId(bytes, inner);
        if (SEGMENT_CHILDREN.has(childId.value)) break;
        const childSize = readSize(bytes, inner + childId.length);
        if (childSize.unknown) throw new Unparseable("unknown-size cluster child");
        inner = inner + childId.length + childSize.length + childSize.value;
      }
      elementEnd = Math.min(inner, end);
    }
    out.push({ id: id.value, start: offset, dataStart, end: elementEnd, unknown: size.unknown });
    offset = elementEnd;
  }
  return out;
}

function readUint(bytes: Uint8Array, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + bytes[i];
  return value;
}

/** Writes `value` into exactly the bytes the old value held, or refuses if it does not fit. */
function writeUint(bytes: Uint8Array, start: number, end: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * (end - start))) throw new Unparseable("uint overflow");
  let rest = value;
  for (let i = end - 1; i >= start; i--) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
}

type Packet = {
  /** Where the packet's signed 16-bit offset inside its cluster is written. */
  offsetAt: number;
  cluster: number;
  time: number;
};

type ClusterInfo = { timecodeStart: number; timecodeEnd: number; time: number };

export function closeWebmTimelineGaps(input: Uint8Array): WebmTimelineRepair {
  const unchanged: WebmTimelineRepair = { bytes: input, closedMs: 0 };
  try {
    return repair(input) ?? unchanged;
  } catch {
    return unchanged;
  }
}

function repair(input: Uint8Array): WebmTimelineRepair | null {
  if (input.length < 8 || readId(input, 0).value !== ID.ebml) return null;
  const top = children(input, 0, input.length);
  const segment = top.find((element) => element.id === ID.segment);
  if (!segment) return null;

  let timecodeScale = 1_000_000;
  let durationField: { start: number; end: number } | null = null;
  const clusters: ClusterInfo[] = [];
  const packets: Packet[] = [];
  const cueTimes: { start: number; end: number; time: number }[] = [];

  for (const element of children(input, segment.dataStart, segment.end)) {
    if (element.id === ID.info) {
      for (const field of children(input, element.dataStart, element.end)) {
        if (field.id === ID.timecodeScale) timecodeScale = readUint(input, field.dataStart, field.end) || timecodeScale;
        if (field.id === ID.duration && (field.end - field.dataStart === 4 || field.end - field.dataStart === 8)) {
          durationField = { start: field.dataStart, end: field.end };
        }
      }
    } else if (element.id === ID.cluster) {
      const parts = children(input, element.dataStart, element.end);
      const timecode = parts.find((part) => part.id === ID.timecode);
      if (!timecode) throw new Unparseable("cluster without a timecode");
      const clusterIndex = clusters.length;
      const clusterTime = readUint(input, timecode.dataStart, timecode.end);
      clusters.push({ timecodeStart: timecode.dataStart, timecodeEnd: timecode.end, time: clusterTime });
      for (const part of parts) {
        const block =
          part.id === ID.simpleBlock
            ? part
            : part.id === ID.blockGroup
              ? children(input, part.dataStart, part.end).find((inner) => inner.id === ID.block)
              : undefined;
        if (!block) continue;
        const track = readSize(input, block.dataStart);
        const offsetAt = block.dataStart + track.length;
        if (offsetAt + 2 > block.end) throw new Unparseable("short block");
        const relative = ((input[offsetAt] << 8) | input[offsetAt + 1]) << 16 >> 16;
        packets.push({ offsetAt, cluster: clusterIndex, time: clusterTime + relative });
      }
    } else if (element.id === ID.cues) {
      for (const point of children(input, element.dataStart, element.end)) {
        if (point.id !== ID.cuePoint) continue;
        const time = children(input, point.dataStart, point.end).find((field) => field.id === ID.cueTime);
        if (time) cueTimes.push({ start: time.dataStart, end: time.end, time: readUint(input, time.dataStart, time.end) });
      }
    }
  }

  if (packets.length < 2) return null;

  // Timestamps are in TimecodeScale units (a millisecond unless the file says otherwise).
  const unitsPerMs = 1_000_000 / timecodeScale;
  const threshold = GAP_THRESHOLD_MS * unitsPerMs;

  // The recording's own step between packets, taken from the ordinary (non-hole) deltas.
  let step = Infinity;
  for (let i = 1; i < packets.length; i++) {
    const delta = packets[i].time - packets[i - 1].time;
    if (delta > 0 && delta <= threshold) step = Math.min(step, delta);
  }
  if (!Number.isFinite(step)) step = FALLBACK_FRAME_MS * unitsPerMs;

  // One pass: the shift each packet is pulled back by, which only ever grows.
  const shifts: number[] = [];
  let shift = 0;
  for (let i = 0; i < packets.length; i++) {
    if (i > 0) {
      const gap = packets[i].time - shift - (packets[i - 1].time - shifts[i - 1]);
      if (gap > threshold) shift += gap - step;
    }
    shifts.push(shift);
  }
  if (shift === 0) return null;

  const bytes = new Uint8Array(input);

  // A cluster's new start is pulled back by its FIRST packet's shift; a later packet in the same cluster
  // that sits after a hole keeps its cluster and has its own offset reduced instead.
  const clusterShift = new Map<number, number>();
  packets.forEach((packet, index) => {
    if (!clusterShift.has(packet.cluster)) clusterShift.set(packet.cluster, shifts[index]);
  });
  clusters.forEach((cluster, index) => {
    const pulled = clusterShift.get(index) ?? (index > 0 ? clusterShift.get(index - 1) ?? 0 : 0);
    clusterShift.set(index, pulled);
    writeUint(bytes, cluster.timecodeStart, cluster.timecodeEnd, cluster.time - pulled);
  });
  packets.forEach((packet, index) => {
    const cluster = clusters[packet.cluster];
    const relative = packet.time - shifts[index] - (cluster.time - (clusterShift.get(packet.cluster) ?? 0));
    if (relative < -32768 || relative > 32767) throw new Unparseable("offset out of range");
    bytes[packet.offsetAt] = (relative >> 8) & 0xff;
    bytes[packet.offsetAt + 1] = relative & 0xff;
  });

  // A cue points at a packet's original time; it moves by the shift of the last packet at or before it.
  for (const cue of cueTimes) {
    let pulled = 0;
    for (let i = 0; i < packets.length && packets[i].time <= cue.time; i++) pulled = shifts[i];
    writeUint(bytes, cue.start, cue.end, cue.time - pulled);
  }

  if (durationField) {
    const last = packets[packets.length - 1].time - shifts[shifts.length - 1] + step;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (durationField.end - durationField.start === 4) view.setFloat32(durationField.start, last);
    else view.setFloat64(durationField.start, last);
  }

  return { bytes, closedMs: shift / unitsPerMs };
}

/** Whether a recording is WebM by its name, its type or its first four bytes. */
export function isWebmRecording(filename: string, contentType: string, audio: Uint8Array): boolean {
  if (/\.webm$/i.test(filename) || /webm/i.test(contentType)) return true;
  return audio.length >= 4 && audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3;
}
