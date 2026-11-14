"use client";

import { QRCodeSVG } from "qrcode.react";

import { SECOND_STEP_QR, SECOND_STEP_QR_LABEL } from "@/lib/auth/second-step-qr";

/**
 * The code an authenticator app scans to add the account, drawn here from the same otpauth:// address
 * the "Open in the app" link carries. Used by the sign-in page's set-up and by the second step's card
 * on the profile. Settings and the reason for each: src/lib/auth/second-step-qr.ts.
 */
export function SecondStepQrCode({ otpauthUri }: { otpauthUri: string }) {
  return (
    <QRCodeSVG
      aria-label={SECOND_STEP_QR_LABEL}
      className="block h-44 w-44 shrink-0"
      data-second-step-qr
      role="img"
      value={otpauthUri}
      {...SECOND_STEP_QR}
    />
  );
}
