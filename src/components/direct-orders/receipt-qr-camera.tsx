"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

import { phxButtonAccentClassName } from "@/components/ui/form-tokens";
import { DIRECT_ORDER_INVOICE_MAX_BYTES } from "@/lib/direct-orders/invoice-evidence";
import { formatReceiptSerial, parseReceiptQrText, RECEIPT_QR_LOCK_START, stepReceiptQrLock } from "@/lib/direct-orders/receipt-rules";
import { PLACE_PHOTO_CAMERA_IDEAL } from "@/lib/phoenix-crm/place-photo-size";
import { openRearCamera } from "@/lib/phoenix-crm/rear-camera";
import { cn } from "@/lib/utils";

/** What the camera hands back: the photo, and — when the QR was read — the receipt it names. */
export type ReceiptCameraShot = {
  dataUrl: string;
  read: { serial: number; code: string } | null;
};

/**
 * How often a frame is looked at for the QR, and how wide that frame is drawn (the full frame is kept for the photo).
 * The QR is 24 mm on an A4 sheet, so pixels decide how far away it still reads: a 1080-wide frame read at 960 needed
 * the page to fill three quarters of the picture (measured 28 Nov 2026). The camera therefore asks for the 2560 x 1440
 * the signboard camera already uses on the reps' phones, and a portrait frame is read at its full width.
 */
const SCAN_EVERY_MS = 220;
const MAX_SCAN_PIXELS = PLACE_PHOTO_CAMERA_IDEAL.width * PLACE_PHOTO_CAMERA_IDEAL.height;
/** With nothing read for this long, the line under the frame asks for the phone to come closer to the QR. */
const CLOSER_HINT_MS = 4000;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The photo could not be read."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(blob);
  });
}

/** A frame as a JPEG under the upload limit — the server reads the QR again from it. */
async function encodePhoto(canvas: HTMLCanvasElement): Promise<string> {
  for (const quality of [0.92, 0.85, 0.75]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size > 0 && blob.size <= DIRECT_ORDER_INVOICE_MAX_BYTES) return readAsDataUrl(blob);
  }
  throw new Error("The photo came out too large. Try again.");
}

/** The whole camera frame as it is now (the shutter, or a frame too big to have been read whole). */
async function captureFrame(video: HTMLVideoElement): Promise<string> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context || width === 0 || height === 0) throw new Error("The camera gave no picture. Try again.");
  context.drawImage(video, 0, 0, width, height);
  return encodePhoto(canvas);
}

/** The phone's own QR reader (Chrome on Android has one). TypeScript's DOM types do not carry it, so it is declared here. */
type NativeQrDetector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>> };
type NativeQrDetectorClass = {
  new (options: { formats: string[] }): NativeQrDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

/** The phone's own QR reader when it has one that reads QR codes; none otherwise, and never an error. */
async function openNativeQrDetector(): Promise<NativeQrDetector | null> {
  const Detector = (globalThis as { BarcodeDetector?: NativeQrDetectorClass }).BarcodeDetector;
  if (typeof Detector !== "function" || typeof Detector.getSupportedFormats !== "function") return null;
  try {
    if (!(await Detector.getSupportedFormats()).includes("qr_code")) return null;
    return new Detector({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

/** Asks the lens to keep focusing: a receipt is held close, and some phones open the camera focused far. Never fails the camera. */
async function keepFocusing(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  try {
    const modes = (track?.getCapabilities?.() as unknown as { focusMode?: string[] } | undefined)?.focusMode;
    if (track && modes?.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as unknown as MediaTrackConstraintSet] });
    }
  } catch {
    // The phone keeps its own focus.
  }
}

/**
 * The live camera that reads a receipt sheet's QR (owner, 28 Nov 2026: "لايف مش ابلود … منوره بالاحمر
 * طول ما هو مش قادر يتعرف عليهم. اول ما … يقدر يتعرف عليهم تنور بالاخضر ويعمل ابلود").
 *
 * The frame is RED while no receipt QR is read and turns GREEN once the same receipt is read on two frames
 * in a row; the full frame is then taken and handed back with the receipt it names — no button. A QR that
 * names a different receipt from `expectedSerial` (Original 2 must carry Original 1's number) stays red and
 * says so. `manual` adds a shutter for a page whose QR will not read: that photo is handed back with no
 * receipt, and the server makes it a hand entry that waits for review.
 *
 * Every frame is read whole, at the camera's full 2560 x 1440: by the phone's own QR reader when it has one
 * (Chrome on Android), then by jsQR. The photo handed back is the very frame that was read, so the server —
 * which reads the QR again and decides — sees exactly what turned the frame green.
 *
 * Opens the REAR lens (rear-camera.ts). Only a help: the server reads the QR again from the photo and
 * decides. When the camera cannot open, `onUnavailable` lets the panel fall back to the phone's own camera.
 */
export function ReceiptQrCamera({
  expectedSerial,
  manual,
  onShot,
  onUnavailable,
}: {
  expectedSerial: number | null;
  manual: boolean;
  onShot: (shot: ReceiptCameraShot) => void;
  onUnavailable: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const doneRef = useRef(false);
  const onShotRef = useRef(onShot);
  const onUnavailableRef = useRef(onUnavailable);
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState<number | null>(null);
  const [wrongSerial, setWrongSerial] = useState<number | null>(null);
  const [closer, setCloser] = useState(false);
  const [taking, setTaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    onShotRef.current = onShot;
    onUnavailableRef.current = onUnavailable;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // When the frame turns green: stepReceiptQrLock (receipt-rules.ts), pinned by tests/direct-order-receipt-books.test.ts.
    let lock = RECEIPT_QR_LOCK_START;
    let lastSeenAt = Date.now();
    let detector: NativeQrDetector | null = null;
    const scanCanvas = document.createElement("canvas");
    const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });

    async function finish(read: { serial: number; code: string }, frameIsWhole: boolean) {
      const video = videoRef.current;
      if (!video || doneRef.current) return;
      doneRef.current = true;
      try {
        // The frame that was read, when it was read whole; otherwise the camera's frame as it is now.
        const dataUrl = frameIsWhole ? await encodePhoto(scanCanvas) : await captureFrame(video);
        if (!cancelled) onShotRef.current({ dataUrl, read });
      } catch (error) {
        doneRef.current = false;
        lock = RECEIPT_QR_LOCK_START;
        setLocked(null);
        setProblem(error instanceof Error ? error.message : "The photo could not be taken. Try again.");
        // Keep looking: a photo that failed once must not leave the frame red for good.
        if (!cancelled) timer = setTimeout(() => void scan(), SCAN_EVERY_MS);
      }
    }

    /** The QR text in the frame on the scan canvas: the phone's own reader first, then jsQR. None when neither reads one. */
    async function readScanCanvas(context: CanvasRenderingContext2D): Promise<string | null> {
      if (detector) {
        try {
          const hit = (await detector.detect(scanCanvas)).find((code) => parseReceiptQrText(code.rawValue) !== null);
          if (hit?.rawValue) return hit.rawValue;
        } catch {
          detector = null; // a reader that fails once is not asked again; jsQR carries on
        }
      }
      const image = context.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
      return jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
    }

    async function scan() {
      if (cancelled || doneRef.current) return;
      const video = videoRef.current;
      if (video && scanContext && video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.min(1, Math.sqrt(MAX_SCAN_PIXELS / (video.videoWidth * video.videoHeight)));
        scanCanvas.width = Math.round(video.videoWidth * scale);
        scanCanvas.height = Math.round(video.videoHeight * scale);
        scanContext.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
        const text = await readScanCanvas(scanContext);
        if (cancelled || doneRef.current) return;
        const token = text ? parseReceiptQrText(text) : null;
        const now = Date.now();
        if (token) {
          lastSeenAt = now;
          setCloser(false);
        } else if (now - lastSeenAt > CLOSER_HINT_MS) {
          setCloser(true);
        }
        const frame = stepReceiptQrLock(lock, token, now, expectedSerial);
        lock = frame.lock;
        if (frame.kind === "wrong_receipt") setWrongSerial(frame.serial);
        else if (frame.kind !== "nothing") setWrongSerial(null);
        if (frame.kind === "locked") {
          setLocked(frame.read.serial);
          void finish(frame.read, scale === 1);
          return;
        }
      }
      timer = setTimeout(() => void scan(), SCAN_EVERY_MS);
    }

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onUnavailableRef.current("This browser cannot open the camera inside Phoenix.");
        return;
      }
      try {
        const stream = await openRearCamera(navigator.mediaDevices, PLACE_PHOTO_CAMERA_IDEAL);
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        await keepFocusing(stream);
        detector = await openNativeQrDetector();
        if (cancelled) return;
        setReady(true);
        void scan();
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        onUnavailableRef.current(
          name === "NotAllowedError"
            ? "The camera was not allowed. Allow the camera for Phoenix in the browser settings."
            : "The camera could not be opened.",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [expectedSerial]);

  async function shutter() {
    const video = videoRef.current;
    if (!video || doneRef.current) return;
    doneRef.current = true;
    setTaking(true);
    try {
      onShotRef.current({ dataUrl: await captureFrame(video), read: null });
    } catch (error) {
      doneRef.current = false;
      setProblem(error instanceof Error ? error.message : "The photo could not be taken. Try again.");
    } finally {
      setTaking(false);
    }
  }

  const green = locked !== null;
  return (
    <div className="space-y-2">
      <div
        className={cn(
          "relative mx-auto w-full max-w-md overflow-hidden border-4 bg-slate-950 transition-colors",
          green ? "border-emerald-600" : "border-rose-600",
        )}
      >
        <video autoPlay className="block max-h-[calc(100svh-18rem)] w-full object-contain" muted playsInline ref={videoRef} />
        {!ready ? (
          <p className="absolute inset-0 flex items-center justify-center text-phx-sm font-bold text-white/80">Opening the camera</p>
        ) : null}
      </div>
      <p className={cn("break-words text-phx-sm font-bold", green ? "text-emerald-700" : "text-rose-700")} role="status">
        {green
          ? `Receipt ${formatReceiptSerial(locked)} read — saving the photo`
          : wrongSerial !== null
            ? `This is receipt ${formatReceiptSerial(wrongSerial)}, not ${formatReceiptSerial(expectedSerial ?? 0)}. Photograph the right page.`
            : closer
              ? "Bring the phone closer, so the QR code fills more of the picture, and hold still."
              : "Hold the page flat and still, with its QR code clearly in the picture."}
      </p>
      {problem ? <p className="text-phx-sm font-bold text-rose-700">{problem}</p> : null}
      {manual ? (
        <button className={cn(phxButtonAccentClassName, "w-full justify-center")} disabled={!ready || taking || green} onClick={() => void shutter()} type="button">
          {taking ? "Taking the photo…" : "Take the photo without the QR"}
        </button>
      ) : null}
    </div>
  );
}
