import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as port from "../mobile/src/lib/evidence-stamp.ts";
import {
  EVIDENCE_LOCATION_UNAVAILABLE_LABEL,
  EVIDENCE_LOGO_SRC,
  computeEvidencePanelLayout,
  drawEvidenceWatermark,
  evidenceLocationWithoutFix,
  formatEvidenceDateTime,
  formatEvidenceDateTimeStamp,
  getCompressedEvidenceCanvasSize,
  readEvidenceLocationStamp,
  wrapWatermarkText,
} from "../src/components/outstation/evidence-watermark.ts";
import {
  formatCoordinatePair,
  formatEvidenceCoordinateLine,
  formatEvidenceLocationLabel,
  formatEvidenceLocationLines,
  type EvidenceLocationStamp,
} from "../src/lib/evidence/location-stamp.ts";
import { PHOENIX_BUSINESS_TIME_ZONE } from "../src/lib/i18n/format.ts";

/**
 * The phone app's evidence stamp is the portal's stamp, line for line and position for position.
 *
 * An approver judges a departure photo by comparing it with the arrival photo of the same trip.
 * The portal burns the stamp with `drawEvidenceWatermark` on a browser canvas; the Android app burns
 * it with Skia, from `mobile/src/lib/evidence-stamp.ts` — a copy, because the app is a separate
 * TypeScript project that cannot import a browser-canvas module. A copy is exactly the thing that
 * drifts, so this runs the web originals and the copy side by side and fails on any difference: the
 * Cairo time, every location fallback, the wrapped lines, the panel geometry, and every draw call's
 * text, baseline, font, ink, shadow and gradient stop.
 *
 * When this goes red after a change to the WEB stamp, change the app's copy in the same PR. Never
 * loosen this test to make the two agree — two photos of one trip stamped two ways is the defect.
 */

/**
 * A stand-in for a font. Every character has its own width, so wrapping breaks at different places
 * for different text, and the heavier weight is wider. The web side measures through a canvas stub
 * that calls this and the app side calls it directly, so a difference in the lines can only come
 * from a difference in the CODE, never from the fonts.
 */
function modelWidth(text: string, sizePx: number, weight: port.EvidenceFontWeight): number {
  let em = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    em += character === " " ? 0.27 : 0.44 + (code % 6) * 0.045;
  }
  return em * sizePx * (weight === 800 ? 1.06 : 1);
}

/** Reads `700 15px sans-serif`. Anything else means the web stamp changed how it sets its font. */
function parseCanvasFont(font: string): { sizePx: number; weight: port.EvidenceFontWeight } {
  const match = /^(\d+) (\d+(?:\.\d+)?)px sans-serif$/.exec(font);
  assert.ok(match, `the web stamp sets its font as "<weight> <size>px sans-serif", got "${font}"`);
  const weight = Number(match[1]);
  assert.ok(weight === 700 || weight === 800, `the stamp draws in weights 700 and 800 only, got ${weight}`);
  return { sizePx: Number(match[2]), weight: weight === 800 ? 800 : 700 };
}

type GradientStop = { color: string; offset: number };

type RecordedCall =
  | { coordinates: number[]; handle: object; kind: "gradient"; stops: GradientStop[] }
  | { fillStyle: unknown; kind: "fillRect"; rect: number[] }
  | {
      fillStyle: unknown;
      font: string;
      kind: "fillText";
      shadowBlur: number;
      shadowColor: string;
      text: string;
      x: number;
      y: number;
    }
  | { image: unknown; kind: "drawImage"; rect: number[]; shadowBlur: number; shadowColor: string };

function callsOf<K extends RecordedCall["kind"]>(calls: RecordedCall[], kind: K) {
  return calls.filter((call): call is Extract<RecordedCall, { kind: K }> => call.kind === kind);
}

/** A 2D context that measures with {@link modelWidth} and writes down every drawing call it gets. */
function recordingContext() {
  const calls: RecordedCall[] = [];
  const state = {
    fillStyle: "#000000" as unknown,
    font: "10px sans-serif",
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
  };

  const context = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value: unknown) {
      state.fillStyle = value;
    },
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    get shadowBlur() {
      return state.shadowBlur;
    },
    set shadowBlur(value: number) {
      state.shadowBlur = value;
    },
    get shadowColor() {
      return state.shadowColor;
    },
    set shadowColor(value: string) {
      state.shadowColor = value;
    },
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      const stops: GradientStop[] = [];
      const handle = {
        addColorStop(offset: number, color: string) {
          stops.push({ color, offset });
        },
      };
      calls.push({ coordinates: [x0, y0, x1, y1], handle, kind: "gradient", stops });
      return handle;
    },
    drawImage(image: unknown, x: number, y: number, width: number, height: number) {
      calls.push({
        image,
        kind: "drawImage",
        rect: [x, y, width, height],
        shadowBlur: state.shadowBlur,
        shadowColor: state.shadowColor,
      });
    },
    fillRect(x: number, y: number, width: number, height: number) {
      calls.push({ fillStyle: state.fillStyle, kind: "fillRect", rect: [x, y, width, height] });
    },
    fillText(text: string, x: number, y: number) {
      calls.push({
        fillStyle: state.fillStyle,
        font: state.font,
        kind: "fillText",
        shadowBlur: state.shadowBlur,
        shadowColor: state.shadowColor,
        text,
        x,
        y,
      });
    },
    measureText(text: string) {
      const { sizePx, weight } = parseCanvasFont(state.font);
      return { width: modelWidth(text, sizePx, weight) };
    },
  };

  return { calls, context: context as unknown as CanvasRenderingContext2D };
}

/**
 * Run the web's `drawEvidenceWatermark` in plain Node.
 *
 * It loads its logo with `new Image()`, which Node does not have: the stub loads instantly and
 * records which file was asked for. The global is put back afterwards, whatever happens.
 */
async function drawOnTheWeb(details: port.EvidenceStampDetails, width: number, height: number) {
  const requestedLogos: string[] = [];
  class StubImage {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    source = "";
    get src() {
      return this.source;
    }
    set src(value: string) {
      this.source = value;
      requestedLogos.push(value);
      queueMicrotask(() => this.onload?.());
    }
  }

  const scope = globalThis as unknown as { Image?: unknown };
  const hadImage = Object.prototype.hasOwnProperty.call(scope, "Image");
  const previousImage = scope.Image;
  scope.Image = StubImage;

  const { calls, context } = recordingContext();
  try {
    await drawEvidenceWatermark(context, { height, width } as unknown as HTMLCanvasElement, details);
  } finally {
    if (hadImage) scope.Image = previousImage;
    else delete scope.Image;
  }
  return { calls, requestedLogos, StubImage };
}

const MOHANDESSIN: EvidenceLocationStamp = {
  accuracyMeters: 12,
  address:
    "12 Ahmed Orabi Street, off Gameat El Dowal El Arabeya, Mohandessin, Giza Governorate 12411, Egypt",
  areaName: "Giza",
  brickDistanceKm: 0.4,
  brickName: "Mohandessin",
  latitude: 30.059482,
  longitude: 31.223145,
  regionName: "Greater Cairo North",
};

/** What the reverse-geocode route sends back for a pin: the server's own wording of the place. */
function serverAnswer(stamp: EvidenceLocationStamp): port.EvidenceLocationResponse {
  return {
    area: stamp.areaName,
    city: "Giza",
    label: stamp.address,
    location: { label: formatEvidenceLocationLabel(stamp), lines: formatEvidenceLocationLines(stamp) },
  };
}

export async function runMobileEvidenceStampParityTests() {
  // ── The time: always Cairo, said out loud, identical on both ─────────────────────
  assert.equal(
    port.EVIDENCE_TIME_ZONE,
    PHOENIX_BUSINESS_TIME_ZONE,
    "the app stamps in the business time zone, never the phone's own",
  );
  for (const instant of [
    "2026-08-23T11:22:05.000Z", // summer, Cairo is UTC+3
    "2026-01-15T09:05:00.000Z", // winter, UTC+2
    "2026-04-23T21:30:00.000Z", // the night the clocks go forward
    "2026-10-29T20:59:59.000Z", // the night they go back
    "2026-12-31T22:30:00.000Z", // already next year in Cairo, not yet in UTC
    "2026-09-18T00:00:00+02:00",
    "not a date",
    "",
  ]) {
    assert.equal(
      port.formatEvidenceDateTime(instant),
      formatEvidenceDateTime(instant),
      `the time "${instant}" reads the same on the app and the portal`,
    );
    assert.equal(
      port.formatEvidenceDateTimeStamp(instant),
      formatEvidenceDateTimeStamp(instant),
      `the stamped time "${instant}" names its zone the same way on both`,
    );
  }

  // ── The pin ─────────────────────────────────────────────────────────────────────
  for (const pin of [
    { accuracyMeters: 12, latitude: 30.059482, longitude: 31.223145 },
    { accuracyMeters: 7.5, latitude: -33.8688, longitude: -70.6693 },
    { accuracyMeters: null, latitude: 0, longitude: 0 },
    { accuracyMeters: Number.NaN, latitude: 25.6872431, longitude: 32.6396357 },
    { accuracyMeters: 1234.5, latitude: Number.NaN, longitude: 31 },
  ]) {
    assert.equal(
      port.formatCoordinatePair(pin.latitude, pin.longitude),
      formatCoordinatePair(pin.latitude, pin.longitude),
      `the coordinate pair ${pin.latitude}, ${pin.longitude} is written the same way`,
    );
    assert.equal(
      port.formatEvidenceCoordinateLine(pin),
      formatEvidenceCoordinateLine({
        ...pin,
        address: null,
        areaName: null,
        brickDistanceKm: null,
        brickName: null,
        regionName: null,
      }),
      `the GPS line for ${pin.latitude}, ${pin.longitude} (±${pin.accuracyMeters}) is the same`,
    );
  }

  // ── Every way the location can come back, and every way it can fail to ──────────
  assert.equal(port.EVIDENCE_LOCATION_UNAVAILABLE_LABEL, EVIDENCE_LOCATION_UNAVAILABLE_LABEL);
  assert.deepEqual(
    port.evidenceLocationWithoutFix(),
    evidenceLocationWithoutFix(),
    "a photo with no GPS fix says so in the same words",
  );
  const payloads: (port.EvidenceLocationResponse | null)[] = [
    null,
    {},
    { location: null },
    serverAnswer(MOHANDESSIN),
    serverAnswer({ ...MOHANDESSIN, address: "١٢ شارع أحمد عرابي، المهندسين، الجيزة ١٢٤١١، مصر" }),
    serverAnswer({ ...MOHANDESSIN, address: null, areaName: null, brickName: null, regionName: null }),
    { location: { label: "  Mohandessin, Giza  ", lines: ["Address: somewhere", 42, null] } },
    { location: { label: "Somewhere", lines: [] } },
    { location: { label: "   ", lines: ["Address: somewhere"] } },
    { location: { label: null, lines: ["Address: somewhere"] } },
    { location: { label: "Somewhere", lines: "Address: somewhere" } },
    { area: "Giza", city: "Giza", label: "a legacy flat label and nothing else" },
  ];
  for (const [index, payload] of payloads.entries()) {
    for (const [latitude, longitude, accuracy] of [
      [30.059482, 31.223145, 12],
      [-33.8688, -70.6693, null],
      [30, 31, 7.5],
      [Number.NaN, 31, null],
    ] as const) {
      assert.deepEqual(
        port.readEvidenceLocationStamp(payload, latitude, longitude, accuracy),
        readEvidenceLocationStamp(payload, latitude, longitude, accuracy),
        `answer #${index} at ${latitude}, ${longitude} becomes the same label and lines`,
      );
    }
    assert.deepEqual(
      port.readEvidenceLocationStamp(payload, 30.1, 31.2),
      readEvidenceLocationStamp(payload, 30.1, 31.2),
      `answer #${index} with no accuracy reported becomes the same label and lines`,
    );
  }

  // ── The upload size ─────────────────────────────────────────────────────────────
  for (const [width, height] of [
    [4032, 3024],
    [3024, 4032],
    [4000, 1800],
    [1280, 720],
    [640, 480],
    [1281, 1279],
    [1, 5000],
    [0, 0],
    [0, 900],
  ] as const) {
    assert.deepEqual(
      port.getCompressedEvidenceSize(width, height),
      getCompressedEvidenceCanvasSize({ naturalHeight: height, naturalWidth: width } as unknown as HTMLImageElement),
      `a ${width}x${height} photo is shrunk to the same upload size`,
    );
  }

  // ── Wrapping one caption ────────────────────────────────────────────────────────
  const fifteen = recordingContext().context;
  fifteen.font = "700 15px sans-serif";
  for (const text of [
    "",
    "   ",
    "one",
    "two  words",
    " leading and trailing ",
    "Address: ١٢ شارع أحمد عرابي، المهندسين، الجيزة",
    "Supercalifragilisticexpialidocious-and-then-some more",
  ]) {
    for (const maxWidth of [0, 40, 180, 900]) {
      assert.deepEqual(
        port.wrapWatermarkText((line) => modelWidth(line, 15, 700), text, maxWidth),
        wrapWatermarkText(fifteen, text, maxWidth),
        `"${text}" wraps into the same lines at ${maxWidth}px`,
      );
    }
  }

  // ── The whole stamp, drawn: every call, in order, at the same place ──────────────
  const places: { lines: string[]; name: string }[] = [
    {
      lines: port.readEvidenceLocationStamp(serverAnswer(MOHANDESSIN), 30.059482, 31.223145, 12).lines,
      name: "an English address",
    },
    {
      lines: port.readEvidenceLocationStamp(
        serverAnswer({ ...MOHANDESSIN, address: "١٢ شارع أحمد عرابي، المهندسين، الجيزة ١٢٤١١، مصر" }),
        30.059482,
        31.223145,
        12,
      ).lines,
      name: "an Arabic address",
    },
    {
      lines: port.readEvidenceLocationStamp(serverAnswer({ ...MOHANDESSIN, brickDistanceKm: 42 }), 30.05, 31.22, 40)
        .lines,
      name: "a brick far from the pin",
    },
    { lines: port.readEvidenceLocationStamp(null, 31.2001, 29.9187, 23.6).lines, name: "a failed lookup" },
    { lines: port.evidenceLocationWithoutFix().lines, name: "no GPS fix" },
    {
      lines: Array.from(
        { length: 12 },
        (_, index) => `Line ${index + 1}: ${"a very long Egyptian street address ".repeat(3)}`,
      ),
      name: "a block too tall for the frame",
    },
  ];
  const details: { details: port.EvidenceStampDetails; name: string }[] = places.map((place) => ({
    details: {
      capturedAt: "2026-08-23T11:22:05.000Z",
      employeeHrId: "B-1042",
      label: port.DEPARTURE_PHOTO_LABEL,
      locationLines: place.lines,
      reference: port.departurePhotoReference(4817),
    },
    name: place.name,
  }));
  details.push(
    {
      details: { ...details[0].details, capturedAt: "" },
      name: "an unreadable capture time",
    },
    {
      details: { ...details[0].details, employeeHrId: "" },
      name: "no HR ID on the session",
    },
  );

  for (const fixture of details) {
    for (const [width, height] of [
      [1280, 720],
      [720, 1280],
      [1280, 960],
      [960, 1280],
      [320, 240],
      [1280, 200],
    ] as const) {
      const where = `${fixture.name} on a ${width}x${height} photo`;
      const plan = port.planEvidenceWatermark(modelWidth, fixture.details, width, height);
      const web = await drawOnTheWeb(fixture.details, width, height);

      assert.deepEqual(
        plan.layout,
        computeEvidencePanelLayout(recordingContext().context, port.buildEvidenceCaptions(fixture.details), width, height),
        `${where}: the panel has the same geometry and the same wrapped lines`,
      );

      assert.deepEqual(
        web.calls.map((call) => call.kind),
        ["gradient", "fillRect", ...plan.texts.map(() => "fillText"), "drawImage"],
        `${where}: the same things are drawn, in the same order`,
      );

      const [gradient] = callsOf(web.calls, "gradient");
      assert.deepEqual(
        gradient.coordinates,
        [plan.band.from.x, plan.band.from.y, plan.band.to.x, plan.band.to.y],
        `${where}: the dark band's gradient runs over the same span`,
      );
      assert.deepEqual(gradient.stops, plan.band.stops, `${where}: through the same colour stops`);

      const [band] = callsOf(web.calls, "fillRect");
      assert.deepEqual(
        band.rect,
        [plan.band.rect.x, plan.band.rect.y, plan.band.rect.width, plan.band.rect.height],
        `${where}: the band covers the same rectangle`,
      );
      assert.equal(band.fillStyle, gradient.handle, `${where}: and is filled with that gradient`);

      assert.deepEqual(
        callsOf(web.calls, "fillText").map((call) => ({
          font: call.font,
          ink: call.fillStyle,
          shadowBlur: call.shadowBlur,
          shadowColor: call.shadowColor,
          text: call.text,
          x: call.x,
          y: call.y,
        })),
        plan.texts.map((run) => ({
          font: `${run.weight} ${run.sizePx}px sans-serif`,
          ink: run.color,
          shadowBlur: run.shadowBlur,
          shadowColor: run.shadowColor,
          text: run.text,
          x: run.x,
          y: run.y,
        })),
        `${where}: every line reads the same and sits on the same baseline, in the same font, ink and shadow`,
      );

      const [logo] = callsOf(web.calls, "drawImage");
      assert.ok(logo.image instanceof web.StubImage, `${where}: the mark drawn is the one that was loaded`);
      assert.deepEqual(
        logo.rect,
        [plan.logo.x, plan.logo.y, plan.logo.size, plan.logo.size],
        `${where}: the mark sits in the same square, bottom right`,
      );
      assert.equal(logo.shadowBlur, plan.logo.shadowBlur, `${where}: the mark's shadow is as soft`);
      assert.equal(logo.shadowColor, plan.logo.shadowColor, `${where}: and as dark`);
      assert.deepEqual(web.requestedLogos, [EVIDENCE_LOGO_SRC], `${where}: the portal loads its one mark`);
    }
  }

  // ── What the portal's departure card passes in, and what the server accepts ──────
  const card = readFileSync(join(process.cwd(), "src/components/outstation/departure-photo-card.tsx"), "utf8");
  assert.ok(
    card.includes(`canvas.toDataURL("image/jpeg", ${port.EVIDENCE_JPEG_QUALITY})`),
    `the portal saves its departure photo as JPEG at ${port.EVIDENCE_JPEG_QUALITY}, the quality the app encodes at`,
  );
  assert.ok(
    card.includes(`label: "${port.DEPARTURE_PHOTO_LABEL}"`),
    `the portal titles the stamp "${port.DEPARTURE_PHOTO_LABEL}", as the app does`,
  );
  assert.ok(
    card.includes("reference: `Request: ${request.id}`"),
    "the portal's reference line is `Request: <id>`",
  );
  assert.equal(port.departurePhotoReference(4817), "Request: 4817", "and the app's is the same");
  assert.ok(
    card.includes(`"${port.OUTSTATION_REVERSE_GEOCODE_PATH}"`),
    "both word the place through the same outstation reverse-geocode route",
  );
  const gpsTimeout = /timeout:\s*([\d_]+)\s*\}/.exec(card);
  assert.ok(gpsTimeout, "the portal's GPS request carries a timeout");
  assert.equal(
    Number(gpsTimeout[1].replace(/_/g, "")),
    port.EVIDENCE_LOOKUP_TIMEOUT_MS,
    "the app waits for the GPS exactly as long as the portal does",
  );

  const watermark = readFileSync(join(process.cwd(), "src/components/outstation/evidence-watermark.ts"), "utf8");
  const lookupTimeout = /const EVIDENCE_LOOKUP_TIMEOUT_MS = ([\d_]+);/.exec(watermark);
  assert.ok(lookupTimeout, "the portal names its address-lookup timeout");
  assert.equal(
    Number(lookupTimeout[1].replace(/_/g, "")),
    port.EVIDENCE_LOOKUP_TIMEOUT_MS,
    "the app waits for the address exactly as long as the portal does",
  );

  const storage = readFileSync(join(process.cwd(), "src/lib/outstation/car-evidence-storage.ts"), "utf8");
  const uploadLimit = /const CAR_EVIDENCE_MAX_UPLOAD_BYTES = ([\d\s*]+);/.exec(storage);
  assert.ok(uploadLimit, "the server names the largest evidence photo it accepts");
  assert.equal(
    uploadLimit[1].split("*").reduce((product, factor) => product * Number(factor.trim()), 1),
    port.EVIDENCE_MAX_UPLOAD_BYTES,
    "the app refuses a stamped photo at the size the server would, before sending it",
  );

  // ── The mark: the same file, and the file the app actually bundles ───────────────
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex");
  assert.equal(
    sha256("mobile/assets/phoenix/camera-watermark.png"),
    sha256(join("public", EVIDENCE_LOGO_SRC)),
    "the app stamps the portal's own watermark mark, byte for byte",
  );
  const capture = readFileSync(join(process.cwd(), "mobile/src/lib/evidence-photo.ts"), "utf8");
  assert.ok(
    capture.includes('require("../../assets/phoenix/camera-watermark.png")'),
    "and that file is the one the app's capture loads",
  );
}
