"use client";

import { useEffect, useState } from "react";

import { CeoHeroClock } from "@/components/admin/ceo-hero-clock";
import { CeoHiddenNote } from "@/components/admin/ceo-hidden-note";
import { cn } from "@/lib/utils";

/** The CEO's own greeting — addressed to him by name, and only ever shown to him. */
function getCeoGreeting(hour: number) {
  if (hour < 12) return { line: "Good morning, Dr. Anwar —", sub: "Your company is awake and working for you." };
  if (hour < 17) return { line: "Good afternoon, Dr. Anwar —", sub: "Here is everything, exactly the way you like to see it." };
  return { line: "Good evening, Dr. Anwar —", sub: "A strong day. Let's close it well." };
}

/** Everyone else is greeted by their OWN name, with copy that fits their remit. */
function getGreeting(hour: number, name: string) {
  const who = name ? `, ${name}` : "";
  if (hour < 12) return { line: `Good morning${who} —`, sub: "Here is where sales and the field stand today." };
  if (hour < 17) return { line: `Good afternoon${who} —`, sub: "Here is where sales and the field stand today." };
  return { line: `Good evening${who} —`, sub: "A strong day. Let's close it well." };
}

/**
 * First name for the greeting. Arabic names here run long ("Khaled Mohamed Ali Bedair"), and the
 * greeting line must not wrap — the owner's standing rule is no wrapping and no ellipsis — so it
 * is addressed to the first given name only.
 */
function firstName(fullName: string): string {
  return String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Premium executive identity block for the CEO hero — full name, title,
 * time-aware greeting, live Cairo clock, discreet hidden note, and (when
 * available) a large portrait bled off the right edge of the hero. All
 * time-sensitive parts run client-side to avoid SSR hydration mismatches;
 * the server renders a stable placeholder first.
 */
export function CeoHeroIdentity({
  fullName,
  roleLabel,
  imageUrl,
  initials,
  /**
   * The CEO's personal hero: his own greeting and the note written for him. Off by default so a
   * new viewer of this component can never inherit either by accident — the SFE Manager was
   * being greeted "Good morning, Dr. Anwar" and handed a note addressed to the Chief Executive.
   */
  personal = false,
  /**
   * The sub-greeting under the greeting line.
   *
   * `undefined` keeps the time-aware default ("Here is where sales and the field stand today"),
   * which is true for the CEO and the SFE Manager. A string overrides it — needed for anyone whose
   * page is not about sales, e.g. the Finance Manager, who holds no `sales` grant at all and would
   * otherwise be greeted with a promise about a page he cannot see. **`null` removes the line
   * entirely** — and it has to be an explicit null rather than an empty string, because `??` would
   * fall straight back through to the sales copy for a role that has no `sales` grant at all.
   */
  subGreeting,
  /**
   * Pull the portrait flush to the hero's right and bottom edges, instead of insetting it 47px
   * from the right and bleeding 4% past the bottom. Flush-bottom means the photo ends exactly
   * where the next section's header bar begins, rather than being clipped mid-figure.
   *
   * Opt-in: the CEO's banner inset and bleed are deliberate and long-standing, and stay untouched.
   */
  flushToEdges = false,
}: {
  fullName: string;
  roleLabel: string;
  imageUrl?: string | null;
  /**
   * Fallback shown in the portrait's place when there is no photo on file yet — e.g. a seat that
   * just opened and has not uploaded one at /admin/profile. Two initials, ready-made by
   * resolveViewerIdentityFromPage. Omit to keep the old behaviour (no photo -> nothing rendered).
   */
  initials?: string;
  personal?: boolean;
  subGreeting?: string | null;
  flushToEdges?: boolean;
}) {
  const [hour, setHour] = useState<number | null>(null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    function cairoHour() {
      const raw = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: "Africa/Cairo",
      }).format(new Date());
      return Number(raw) % 24;
    }
    // Defer out of the synchronous effect body to satisfy react-hooks/set-state-in-effect.
    const id = setTimeout(() => setHour(cairoHour()), 0);
    return () => clearTimeout(id);
  }, []);

  const { line: greetLine, sub: greetSub } =
    hour !== null
      ? (personal ? getCeoGreeting(hour) : getGreeting(hour, firstName(fullName)))
      : {
          line: `Welcome, ${personal ? fullName : firstName(fullName)} —`,
          sub: personal
            ? "Here is everything, exactly the way you like to see it."
            : "Here is where sales and the field stand today.",
        };

  const showPhoto = Boolean(imageUrl) && !imgError;
  const showInitials = !showPhoto && Boolean(initials);

  return (
    <>
      <div
        className={cn(
          "flex flex-col gap-6 sm:flex-row sm:items-start",
          showPhoto && "sm:pr-[34%] lg:pr-[30%]",
          // Reserved runway for the medallion, which is absolutely positioned and so cannot push
          // this text aside itself. Kept in step with the badge BY HAND: at lg the badge is 160px
          // wide and sits 56px off the right edge, so anything under 216px here lets a long name
          // run under it. Grow both together or neither.
          showInitials && "sm:pr-48 lg:pr-60",
        )}
      >
        {/* ── Identity + greeting ───────────────────────────────────────────── */}
        <div className="min-w-0 flex-1">
          {/* Role label */}
          <p className="text-phx-xs font-black uppercase tracking-[0.32em] text-orange-300/80">
            {roleLabel}
          </p>

          {/* Full name */}
          <h2 className="mt-1 text-[26px] font-black leading-none tracking-[-0.02em] text-white sm:text-[30px] lg:text-[32px]">
            {fullName}
          </h2>

          {/* Decorative divider */}
          <div className="my-1 flex items-center gap-3">
            <div className="h-px w-8 bg-orange-500" />
            <div className="h-px flex-1 bg-white/10" />
          </div>

          {/* Time-aware greeting + hidden note */}
          <div className="flex items-center gap-2.5">
            <p className="text-phx-lg font-semibold leading-snug text-slate-100">{greetLine}</p>
            {personal ? <CeoHiddenNote /> : null}
          </div>

          {/* Sub-greeting — omitted entirely when the caller passes null. */}
          {subGreeting === null ? null : (
            <p className="mt-1 max-w-md text-sm leading-relaxed text-slate-400">
              {subGreeting ?? greetSub}
            </p>
          )}

          {/* Live Cairo clock */}
          <div className="mt-2 flex w-fit items-center border border-white/10 bg-white/[0.04] text-xs">
            <CeoHeroClock />
          </div>
        </div>
      </div>

      {/* ── Executive portrait — flush with the hero's top edge, bled slightly off the bottom
          (clipped by the hero's own overflow-hidden), does not affect the hero's height ── */}
      {showPhoto ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0 hidden max-w-[46%] items-end justify-end sm:flex",
            flushToEdges ? "right-0 bottom-0" : "right-[47px] bottom-[-4%]",
          )}
        >
          {/* A warm glow behind the subject so a dark studio portrait separates from the dark
              hero instead of dissolving into it. Non-personal heroes only — the CEO's banner
              is deliberately left exactly as it was. */}
          {!personal ? (
            <span
              aria-hidden="true"
              className="absolute bottom-0 right-[6%] h-[78%] w-[70%] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(249,115,22,0.20)_0%,rgba(249,115,22,0.07)_45%,transparent_72%)] blur-2xl"
            />
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl!}
            alt=""
            onError={() => setImgError(true)}
            className={cn(
              "relative h-full w-auto max-w-none object-contain object-bottom",
              // In-app "polish": a contrast/saturation lift so the portrait matches the hero's
              // amber grade, and a two-axis fade. The LEFT fade matters most — this asset is a
              // rectangular photo with its own dark studio background, so without it the frame
              // ends on a visible vertical seam instead of dissolving into the hero. This is a
              // CSS grade, not a retouch of the file.
              !personal &&
                "[filter:contrast(1.07)_saturate(1.1)_brightness(1.05)] [mask-image:linear-gradient(to_right,transparent_0%,rgba(0,0,0,0.35)_10%,#000_34%),linear-gradient(to_bottom,#000_0%,#000_80%,rgba(0,0,0,0.5)_92%,transparent_100%)] [mask-composite:intersect] [-webkit-mask-composite:source-in]",
            )}
          />
        </div>
      ) : null}

      {/* ── Initials medallion — the placeholder when no photo is on file yet. A vertically
          centred badge rather than a bled portrait: there is no image to bleed, and forcing two
          letters to fill a portrait's footprint would look like a broken image, not a design. It
          disappears the moment the seat uploads a real photo at /admin/profile — showPhoto then
          takes over and this block never renders again. */}
      {showInitials ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-6 top-1/2 hidden -translate-y-1/2 sm:right-10 sm:flex lg:right-14"
        >
          <span
            aria-hidden="true"
            className="absolute inset-0 -m-4 bg-[radial-gradient(circle_at_center,rgba(249,115,22,0.22)_0%,rgba(249,115,22,0.06)_55%,transparent_75%)] blur-xl"
          />
          {/* SQUARE, deliberately — and do not "fix" it to a circle.
              `app/globals.css` RULE 1 zeroes border-radius for every element inside `.admin-shell`
              ("NOTHING is rounded or semi-rounded"), with `!important`, so `rounded-full` here was
              inert: it rendered as a square while the code claimed a circle, which is the kind of
              lie that sends the next session hunting a CSS bug that does not exist. Measured
              `border-radius: 0px` on the live page. The class is gone rather than overridden,
              because every card, chip and tile in this shell is sharp and a single round badge
              would be exactly the one-off look the owner's rule forbids. */}
          <div className="relative flex h-28 w-28 items-center justify-center border border-orange-400/40 bg-gradient-to-br from-orange-500/30 via-orange-400/10 to-white/5 shadow-[0_16px_40px_rgba(249,115,22,0.28)] sm:h-32 sm:w-32 lg:h-40 lg:w-40">
            <span className="text-[2.25rem] font-black tracking-tight text-orange-50 sm:text-[2.75rem] lg:text-[3.25rem]">
              {initials}
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
