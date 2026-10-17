import { createElement, type CSSProperties, type ReactElement, type ReactNode } from "react";

import { SIGNATURE_TAGLINE, type SignatureLines } from "@/lib/email-signature/signature-content";

// The signature picture, drawn as a tree of plain boxes and text that next/og turns into a PNG.
//
// Everything is written in CSS pixels of the SHOWN size (480 x 168) and multiplied by SCALE, so the
// file is twice as sharp as it is shown — a mail app displays it at 480 wide and a retina screen gets
// the extra pixels. The colours are the house blues and the Phoenix orange of the signature the owner
// approved; the face is Montserrat, the Sato card face.

export const SIGNATURE_SHOWN_WIDTH = 480;
export const SIGNATURE_SHOWN_HEIGHT = 168;
export const SIGNATURE_SCALE = 2;
export const SIGNATURE_PIXEL_WIDTH = SIGNATURE_SHOWN_WIDTH * SIGNATURE_SCALE;
export const SIGNATURE_PIXEL_HEIGHT = SIGNATURE_SHOWN_HEIGHT * SIGNATURE_SCALE;

export type SignatureAssets = {
  /** The Phoenix emblem, as a data: URI. */
  emblem: string;
  /** The Sato Pharma logo on a light ground, as a data: URI. */
  sato: string;
};

const COLOR = {
  deep: "#0A527D",
  blue: "#0A6BA6",
  orange: "#F47B20",
  rust: "#C2410C",
  ink: "#1A1A1A",
  muted: "#5A6B7C",
  hair: "#B9C7D4",
  paper: "#FFFFFF",
} as const;

const px = (shown: number) => shown * SIGNATURE_SCALE;

function box(style: CSSProperties, ...children: ReactNode[]): ReactElement {
  return createElement("div", { style: { display: "flex", ...style } }, ...children);
}

function text(style: CSSProperties, value: string): ReactElement {
  return createElement("div", { style: { display: "flex", ...style } }, value);
}

function picture(src: string, shownWidth: number, shownHeight: number): ReactElement {
  return createElement("img", {
    height: px(shownHeight),
    src,
    style: { height: px(shownHeight), width: px(shownWidth) },
    width: px(shownWidth),
  });
}

/**
 * A long name or address must shrink to fit, never run off the picture. Montserrat's average advance is
 * about 0.62 em, so the largest size that fits `room` shown pixels is room / (length x 0.62), kept
 * between a floor (still readable) and the design size.
 */
export function fittedSize(value: string, room: number, designSize: number, floor: number): number {
  const fits = room / (Math.max(value.length, 1) * 0.62);
  return Math.round(Math.max(floor, Math.min(designSize, fits)) * 10) / 10;
}

const NAME_ROOM = 308;
const VALUE_ROOM = 262;

function fact(label: string, value: string): ReactElement {
  return box(
    { alignItems: "center", marginTop: px(3) },
    text(
      { color: COLOR.blue, fontSize: px(7.5), fontWeight: 700, letterSpacing: px(1.4), textTransform: "uppercase", width: px(46) },
      label,
    ),
    text({ color: COLOR.ink, fontSize: px(fittedSize(value, VALUE_ROOM, 10.5, 8.5)), fontWeight: 400 }, value),
  );
}

export function buildSignatureElement(lines: SignatureLines, assets: SignatureAssets): ReactElement {
  const facts: ReactElement[] = [];
  if (lines.mobile) facts.push(fact("Mobile", lines.mobile));
  if (lines.email) facts.push(fact("Email", lines.email));
  facts.push(fact("Web", `${lines.web}   |   ${lines.office}`));

  const identity = box(
    { flexDirection: "column", flexGrow: 1, justifyContent: "center", paddingLeft: px(18) },
    text({ color: COLOR.deep, fontSize: px(fittedSize(lines.name, NAME_ROOM, 18, 11.5)), fontWeight: 700, lineHeight: 1.15 }, lines.name),
    lines.title
      ? text(
          { color: COLOR.blue, fontSize: px(8.5), fontWeight: 700, letterSpacing: px(1.8), marginTop: px(3), textTransform: "uppercase" },
          lines.title,
        )
      : null,
    lines.area ? text({ color: COLOR.muted, fontSize: px(9.5), fontWeight: 400, marginTop: px(2) }, lines.area) : null,
    box(
      { alignItems: "center", height: px(2), marginTop: px(7) },
      box({ backgroundColor: COLOR.deep, height: px(2), width: px(30) }),
      box({ backgroundColor: COLOR.orange, height: px(2), marginLeft: px(4), width: px(8) }),
    ),
    box({ flexDirection: "column", marginTop: px(5) }, ...facts),
  );

  const mark = box(
    { alignItems: "center", flexShrink: 0, justifyContent: "center", width: px(124) },
    picture(assets.sato, 100, 39),
  );

  const main = box(
    { alignItems: "stretch", flexGrow: 1, paddingBottom: px(6), paddingLeft: px(12), paddingRight: px(14), paddingTop: px(12) },
    mark,
    box({ alignSelf: "center", backgroundColor: COLOR.hair, height: px(92), width: px(1) }),
    identity,
  );

  const strip = box(
    { alignItems: "center", borderTop: `${px(1)}px solid ${COLOR.hair}`, height: px(36), marginLeft: px(14), marginRight: px(14) },
    picture(assets.emblem, 26, 26),
    box(
      { flexDirection: "column", marginLeft: px(9) },
      box(
        { fontSize: px(8.5), fontWeight: 700, letterSpacing: px(1.8) },
        text({ color: COLOR.ink }, "PHOENIX"),
        text({ color: COLOR.rust, marginLeft: px(5) }, "WORKFORCE"),
      ),
      text({ color: COLOR.muted, fontSize: px(9), fontWeight: 400, marginTop: px(1) }, SIGNATURE_TAGLINE),
    ),
  );

  const bar = box(
    { flexShrink: 0, height: px(3) },
    box({ backgroundColor: COLOR.deep, flexGrow: 5 }),
    box({ backgroundColor: COLOR.orange, flexGrow: 2 }),
  );

  return box(
    {
      backgroundColor: COLOR.paper,
      flexDirection: "column",
      fontFamily: "Montserrat",
      height: SIGNATURE_PIXEL_HEIGHT,
      width: SIGNATURE_PIXEL_WIDTH,
    },
    main,
    strip,
    bar,
  );
}
