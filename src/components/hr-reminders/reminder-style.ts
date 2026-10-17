// HR Reminders — the board's look, kept in one place so the cards, the calendars and the editor
// cannot disagree about what "ember" is.
//
// Every class is written out in full (Tailwind reads source text, never a built string), and every
// shape is square (the square-edge golden rule): the colour swatches and the owner's mark included.

import type { ReminderColor } from "@/lib/hr-reminders/types";

export type ColorStyle = {
  /** The vertical bar down a card's left edge. */
  bar: string;
  /** The small swatch / calendar dot. */
  dot: string;
  label: string;
  /** A calendar chip: tinted ground, coloured edge, dark ink. */
  chip: string;
};

export const COLOR_STYLES: Record<ReminderColor, ColorStyle> = {
  amber: {
    bar: "bg-amber-500",
    chip: "border-l-[3px] border-amber-500 bg-amber-50 text-amber-950 hover:bg-amber-100",
    dot: "bg-amber-500",
    label: "Amber",
  },
  ember: {
    bar: "bg-orange-700",
    chip: "border-l-[3px] border-orange-700 bg-orange-100/70 text-orange-950 hover:bg-orange-100",
    dot: "bg-orange-700",
    label: "Ember",
  },
  ink: {
    bar: "bg-slate-900",
    chip: "border-l-[3px] border-slate-900 bg-slate-100 text-slate-900 hover:bg-slate-200/70",
    dot: "bg-slate-900",
    label: "Ink",
  },
  orange: {
    bar: "bg-orange-500",
    chip: "border-l-[3px] border-orange-500 bg-orange-50 text-orange-950 hover:bg-orange-100/80",
    dot: "bg-orange-500",
    label: "Orange",
  },
  slate: {
    bar: "bg-slate-400",
    chip: "border-l-[3px] border-slate-400 bg-slate-50 text-slate-700 hover:bg-slate-100",
    dot: "bg-slate-400",
    label: "Slate",
  },
};

/** Gradient controls and tabs, the same skin the Interview Calendar wears. */
export const CONTROL_SKIN =
  "border border-slate-200/90 bg-[linear-gradient(180deg,#FFFFFF_0%,#F7F9FC_100%)]"
  + " shadow-[0_1px_2px_rgba(15,23,42,0.045)] transition-all duration-200 hover:border-orange-200"
  + " hover:text-orange-600 hover:shadow-[0_6px_14px_rgba(15,23,42,0.09)]"
  + " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500";

export const TAB_BASE = "inline-flex items-center gap-2 px-4 py-2 text-sm font-bold";

export const TAB_ON =
  "border border-orange-200 bg-[linear-gradient(180deg,#FFF7ED_0%,#FFF1E3_100%)] text-orange-700"
  + " shadow-[0_1px_2px_rgba(249,115,22,0.12)] focus-visible:outline-none focus-visible:ring-2"
  + " focus-visible:ring-orange-500";

export const TAB_OFF = `text-slate-500 ${CONTROL_SKIN}`;

/** "YG" mark for an owner: a square, like everything else here. */
export const MEDALLION =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center bg-slate-900 text-[10px] font-black tracking-wide text-white";
