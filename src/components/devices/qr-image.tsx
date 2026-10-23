"use client";

/**
 * Drawing an enrollment QR, shared by the enrollment paths — Google's Android Management token
 * and the Headwind enrolment code.
 *
 * ONE COPY, because the paths draw the same thing and a second copy would drift. It moved here
 * from `rep-tablets-console.tsx` on 2026-09-25, when a second enrollment path arrived; nothing
 * about how it draws changed.
 *
 * 🔴 THE SYMBOL IS DRAWN BY REACT — one `<path>` from Phoenix's own encoder — not by a library
 * writing into a DOM node. On 2026-09-18 production's Managed Google Play page crashed because a
 * script wrote into an element React also rendered into. Nothing here hands a node to anyone: the
 * PNG download builds a detached canvas and clicks a detached anchor, neither of which is ever
 * appended to the document.
 */

import { useMemo } from "react";

import { QR_QUIET_ZONE, qrSvgPath, type QrCode as QrSymbol } from "@/lib/qr/qr-code";

export function QrImage({ code, label }: { code: QrSymbol; label: string }) {
  const side = code.size + QR_QUIET_ZONE * 2;
  const path = useMemo(() => qrSvgPath(code), [code]);
  return (
    <svg
      aria-label={label}
      className="block h-auto w-full max-w-[360px] border border-slate-200 bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${side} ${side}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#ffffff" height={side} width={side} />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/**
 * A PNG of the code with a caption under it, for printing or showing on a second screen.
 *
 * The anchor is clicked DETACHED — never appended to the document — so nothing is added to a tree
 * React owns, not even for a moment.
 */
export function saveQrImage(code: QrSymbol, caption: string, fileName: string) {
  const scale = 12;
  const side = (code.size + QR_QUIET_ZONE * 2) * scale;
  const captionHeight = 72;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side + captionHeight;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) context.fillRect((x + QR_QUIET_ZONE) * scale, (y + QR_QUIET_ZONE) * scale, scale, scale);
    });
  });
  context.fillStyle = "#0f172a";
  context.font = "bold 26px Arial, sans-serif";
  context.textAlign = "center";
  context.fillText(caption, side / 2, side + captionHeight / 2, side - 2 * QR_QUIET_ZONE * scale);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, "image/png");
}
