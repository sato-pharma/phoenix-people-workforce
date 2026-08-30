import Link from "next/link";
import { Lock } from "lucide-react";

import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { MODULE_LOCK_HEADLINE, type ModuleLock } from "@/lib/auth/module-locks";
import { moduleLabel } from "@/lib/navigation/module-catalog";

/**
 * What a locked-out person sees instead of the page.
 *
 * The owner's own wording is the headline, and it is the whole point of the screen: the person must
 * learn that a HUMAN closed this deliberately and temporarily, not that the system broke. A raw
 * "Forbidden" reads as a fault and generates a support request; this reads as a decision and
 * generates a phone call to the right person.
 *
 * Everything below the headline is optional detail, and every line of it is answering the question
 * the headline provokes — which module, why, and when do I get it back.
 */
export function ModuleLockedNotice({
  homeHref = "/",
  lock,
  moduleKey,
}: {
  /** Where "Back" goes — the viewer's own shell home, resolved by the caller. */
  homeHref?: string;
  lock?: ModuleLock | null;
  moduleKey: string;
}) {
  const name = moduleLabel(lock?.moduleKey ?? moduleKey);
  const note = lock?.note?.trim();

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl rounded-2xl border border-amber-200/90 bg-gradient-to-b from-amber-50/80 to-white p-8 text-center shadow-[0_20px_48px_rgba(15,23,42,0.10)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-200">
          <Lock className="h-6 w-6" />
        </div>

        <h1 className="mt-5 text-xl font-black tracking-tight text-slate-900">{MODULE_LOCK_HEADLINE}</h1>

        <p className="mt-3 text-sm leading-6 text-slate-600">
          The <span className="font-bold text-slate-900">{name}</span> module is closed for your
          account at the moment. Your account and everything else in Phoenix are unaffected.
        </p>

        {note ? (
          <p className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700">
            {note}
          </p>
        ) : null}

        <p className="mt-4 text-sm leading-6 text-slate-500">
          {lock?.unlockAt
            ? `Access returns automatically on ${cairoDateTime(lock.unlockAt)} (Cairo time).`
            : "It reopens as soon as the system administrator releases it."}
        </p>

        <Link
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-phx-accent px-4 py-2 text-sm font-bold text-white shadow-[0_8px_16px_rgba(249,115,22,0.28)] transition hover:bg-phx-accent-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60"
          href={homeHref}
        >
          Back to my home page
        </Link>
      </div>
    </div>
  );
}
