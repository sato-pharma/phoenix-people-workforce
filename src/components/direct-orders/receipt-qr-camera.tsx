"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

import { phxButtonAccentClassName } from "@/components/ui/form-tokens";
import { DIRECT_ORDER_INVOICE_MAX_BYTES } from "@/lib/direct-orders/invoice-evidence";
import { formatReceiptSerial, parseReceiptQrText } from "@/lib/direct-orders/receipt-rules";
import { openRearCamera } from "@/lib/phoenix-crm/rear-camera";
import { cn } from "@/lib/utils";

/** What the camera hands back: the photo, and — when the QR was read — the receipt it names. */
export type ReceiptCameraShot = {
  dataUrl: string;
  read: { serial: number; code: string } | null;
};

/** How often a frame is looked at for the QR, and how wide that frame is drawn (the full frame is kept for the photo). */
const SCAN_EVERY_MS = 220;
const SCAN_WIDTH = 960;
/** The same receipt read on this many frames in a row turns the frame green — one blurred frame never does. */
const READS_TO_LOCK = 2;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The photo could not be read."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(blob);
  });
}

/** The whole camera frame, as a JPEG under the upload limit — the server reads the QR again from it. */
async function captureFrame(video: HTMLVideoElement): Promise<string> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context || width === 0 || height === 0) throw new Error("The camera gave no picture. Try again.");
  context.drawImage(video, 0, 0, width, height);
  for (const quality of [0.92, 0.85, 0.75]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size > 0 && blob.size <= DIRECT_ORDER_INVOICE_MAX_BYTES) return readAsDataUrl(blob);
  }
  throw new Error("The photo came out too large. Try again.");
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
  const [taking, setTaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    onShotRef.current = onShot;
    onUnavailableRef.current = onUnavailable;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastToken = "";
    let streak = 0;
    const scanCanvas = document.createElement("canvas");
    const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });

    async function finish(read: { serial: number; code: string }) {
      const video = videoRef.current;
      if (!video || doneRef.current) return;
      doneRef.current = true;
      try {
        const dataUrl = await captureFrame(video);
        if (!cancelled) onShotRef.current({ dataUrl, read });
      } catch (error) {
        doneRef.current = false;
        streak = 0;
        setLocked(null);
        setProblem(error instanceof Error ? error.message : "The photo could not be taken. Try again.");
      }
    }

    function scan() {
      if (cancelled || doneRef.current) return;
      const video = videoRef.current;
      if (video && scanContext && video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.min(1, SCAN_WIDTH / video.videoWidth);
        scanCanvas.width = Math.round(video.videoWidth * scale);
        scanCanvas.height = Math.round(video.videoHeight * scale);
        scanContext.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
        const image = scanContext.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
        const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        const token = found ? parseReceiptQrText(found.data) : null;
        if (token && expectedSerial !== null && token.serial !== expectedSerial) {
          setWrongSerial(token.serial);
          streak = 0;
          lastToken = "";
        } else if (token) {
          setWrongSerial(null);
          const key = `${token.serial}-${token.code}`;
          streak = key === lastToken ? streak + 1 : 1;
          lastToken = key;
          if (streak >= READS_TO_LOCK) {
            setLocked(token.serial);
            void finish(token);
            return;
          }
        } else {
          streak = 0;
          lastToken = "";
        }
      }
      timer = setTimeout(scan, SCAN_EVERY_MS);
    }

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onUnavailableRef.current("This browser cannot open the camera inside Phoenix.");
        return;
      }
      try {
        const stream = await openRearCamera(navigator.mediaDevices, { height: 1080, width: 1920 });
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
        setReady(true);
        scan();
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
