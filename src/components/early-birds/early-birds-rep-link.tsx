import Link from "next/link";

import { earlyBirdsHref } from "./early-birds-links";

// A rep's name, as the way into his record.
//
// Before this, a name on the board was inert text: a District Manager looking at the rep sitting
// 14th could see THAT he was 14th and nothing else — not when he starts, not whether 14th is where
// he always sits or where he has just fallen to. The owner asked for exactly that on 2026-09-18
// ("what if a manager wants to see ... a medical rep in his team — when does he start?"), and the
// name is the thing he is already looking at when he asks it.
//
// Rendered as a plain <span> when no context is passed, so a surface that has no board URL to link
// back to (an email, a future export) renders the same name with no dead anchor in it.

export type EarlyBirdsRepLinkContext = {
  basePath: string;
  district?: string | null;
  /** The fortnight stays pinned — opening a rep from August must not jump back to today. */
  period: string;
};

export function EarlyBirdsRepLink({
  link,
  hrId,
  name,
  active = false,
  className = "",
}: {
  link?: EarlyBirdsRepLinkContext | null;
  /** Stored casing. Empty means we have no id to address him by — render plain text. */
  hrId: string;
  name: string;
  active?: boolean;
  className?: string;
}) {
  if (!link || !hrId) {
    return (
      <span className={`min-w-0 break-words ${className}`} dir="auto">
        {name}
      </span>
    );
  }

  return (
    <Link
      aria-current={active ? "true" : undefined}
      // Underline on hover only: a board of twelve permanently-underlined names reads as a list of
      // links rather than a ranking. The open rep is marked by colour, which survives a phone where
      // there is no hover at all.
      className={`min-w-0 break-words underline-offset-2 hover:text-orange-600 hover:underline ${
        active ? "text-orange-700" : ""
      } ${className}`}
      dir="auto"
      href={earlyBirdsHref(link.basePath, { district: link.district, period: link.period, rep: hrId })}
      title={`Open ${name}'s record`}
    >
      {name}
    </Link>
  );
}
