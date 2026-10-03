"use client";

import { useCallback, useState } from "react";
import { FileText, Image as ImageIcon, Loader2, Share2 } from "lucide-react";

import {
  SHARE_TARGETS,
  performanceShareCaption,
  shareComposerUrl,
  shareFallbackHint,
  type ShareTargetId,
} from "@/lib/share/social-share";
import type { RepRankStanding } from "@/lib/employee-portal/rep-rank";

/**
 * ONE STRIP: where he ranks, and the buttons that take it with him.
 *
 * 🔒 THE OWNER'S OWN RULING, 2026-10-03, after the first build: *"the page became so crowded. I want
 * only a strip telling the rank in company and line, then buttons telling the export or share. That
 * simple, easy cake — not all over-engineered."* It replaced two full-width medals and a separate
 * export panel — three stacked blocks that took ~330px of a phone before the rep reached his own
 * keycards. This is ONE bar, about 90px on a phone and a single row on a laptop.
 *
 * WHAT SURVIVED THE CUT, and why each is not ornament:
 *   · THE TWO BRAND METALS. Phoenix gold is the company rank, Sato blue is the line rank — colour is
 *     what tells the two apart now that neither has a label of its own beyond one word.
 *   · THE NAVY FIELD. It is the identity card's own band, so the strip belongs to the banner above it
 *     rather than reading as a fourth white panel.
 *   · THE WINDOW. A rank with no period on it is a fact about nothing, and this one is cumulative
 *     over every published month — it is never the month on the keycards below.
 * Gone: the seals, the struck ghost numerals, the corner brackets, the sheen, the card thumbnail and
 * the explanatory sentence. None of them told him anything the two figures do not.
 *
 * NOTHING POSTS ON ITS OWN. The share buttons open the OS share sheet with the picture (the only
 * route to WhatsApp Status, and the real mechanism on the reps' tablets) or that platform's own
 * composer with the picture saved to attach. Every share is his own tap about his own card.
 */

type ShareFile = { blob: Blob; filename: string };

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}

function LinkedInGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function FacebookGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function Glyph({ id, className }: { id: ShareTargetId; className?: string }) {
  if (id === "linkedin") return <LinkedInGlyph className={className} />;
  if (id === "facebook") return <FacebookGlyph className={className} />;
  return <WhatsAppGlyph className={className} />;
}

/** Synchronously, inside the click: a composer opened after an await is blocked as a popup. */
function supportsFileShare(): boolean {
  try {
    const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
    const probe = [new File([new Uint8Array()], "x.png", { type: "image/png" })];
    return typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: probe });
  } catch {
    return false;
  }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function RepHonourStrip({ standing }: { standing: RepRankStanding | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // 🔒 COLLAPSED BY DEFAULT. Owner, 2026-10-03: "the share strip is taking more space than the rank —
  // what is the primary and what is the extra?" The RANK is the strip; saving and sharing are an
  // afterthought behind one 26px button, opened only by the rep who actually wants them.
  const [open, setOpen] = useState(false);

  const render = useCallback(async (format: "png" | "pdf"): Promise<Blob> => {
    const response = await fetch("/api/employee-portals/performance-card", {
      body: JSON.stringify({ format }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      // The route answers its refusals in plain words — show HIS sentence, never a status code.
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? "Your card could not be rendered.");
    }
    return response.blob();
  }, []);

  const save = useCallback(
    async (format: "png" | "pdf") => {
      setBusy(format);
      setNote(null);
      try {
        saveBlob(await render(format), `sato-performance-card.${format}`);
      } catch (cause) {
        setNote(cause instanceof Error ? cause.message : "Your card could not be rendered.");
      } finally {
        setBusy(null);
      }
    },
    [render],
  );

  const share = useCallback(
    async (target: ShareTargetId) => {
      setBusy(target);
      setNote(null);
      // Opened synchronously so it keeps user activation; navigated or closed once we know more.
      const popup = supportsFileShare() ? null : window.open("", "_blank");
      try {
        const blob = await render("png");
        const file: ShareFile = { blob, filename: "sato-performance-card.png" };
        const caption = performanceShareCaption(standing?.windowLabel ?? "", rankClauseOf(standing));

        if (supportsFileShare()) {
          const payload = new File([file.blob], file.filename, { type: "image/png" });
          await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({
            files: [payload],
            text: caption,
          });
          if (popup) popup.close();
          return;
        }

        // No file sharing here: save the picture, mint the public link so the platform can preview
        // the card, and open that platform's composer for him to attach it.
        saveBlob(file.blob, file.filename);
        let pageUrl: string | null = null;
        try {
          const minted = await fetch("/api/employee-portals/performance-card", { method: "GET" });
          if (minted.ok) pageUrl = ((await minted.json()) as { shareUrl?: string }).shareUrl ?? null;
        } catch {
          pageUrl = null;
        }
        const composer = shareComposerUrl(target, caption, pageUrl ?? undefined);
        if (composer) {
          if (popup && !popup.closed) popup.location.href = composer;
          else window.open(composer, "_blank", "noopener,noreferrer");
        } else if (popup) {
          popup.close();
        }
        setNote(shareFallbackHint(target));
      } catch (cause) {
        if (popup && !popup.closed) popup.close();
        // A share the person cancelled from the OS sheet is not an error worth shouting about.
        const message = cause instanceof Error ? cause.message : "";
        if (!/abort/i.test(message)) setNote(message || "The picture could not be shared.");
      } finally {
        setBusy(null);
      }
    },
    [render, standing],
  );

  if (!standing) return null;
  const company = standing.company;
  const line = standing.line;

  // 🔒 EVEN CELLS, DIVIDED BY ONE RULE EACH (owner, 2026-10-03: "separate the rankings by even
  // borders"). A stat band, not two phrases sharing a line: each ranking owns an equal track and the
  // divider between them is a single hairline.
  const cells = [
    company
      ? { key: "company", label: "Company", ink: "text-[#f47b20]", rank: company.rank, outOf: company.outOf }
      : null,
    // 🔒 THE LABEL IS WRITTEN OUT IN FULL — "<name> line", never shortened to the name (owner,
    // 2026-10-03: "no truncation ever"). Dropping the word was tried as a way to stop the longest
    // line name stacking three deep on a phone and was REFUSED: cutting a word to make it fit IS
    // truncation, and his standing rule is that where text collides with the space, WRAPPING wins.
    // So the words stay and the PANEL grows instead — see the panel's own note below.
    line
      ? { key: "line", label: `${line.lineName} line`, ink: "text-[#0879b8]", rank: line.rank, outOf: line.outOf }
      : null,
  ].filter((cell): cell is NonNullable<typeof cell> => cell !== null);

  // 🔒 THE PANEL GROWS FOR A LONG LABEL — IT NEVER SHORTENS ONE (owner, 2026-10-03: "no truncation
  // ever"). On a phone the panel is 10 grid squares wide, so each label has about 78px — roughly nine
  // of these letter-spaced capitals a line. "ANTI INFECTIVE LINE" needs three of them, and in a
  // six-square panel those three filled it edge to edge and pushed the orange tick out of the top.
  // The panel steps up to EIGHT squares instead, which is the same even-square cut one size larger,
  // and the whole label is readable with the tick back inside. Short labels (`Company`, `CNS line`)
  // are untouched at six, so nothing moves for a CNS or Pedia rep.
  // 🔴 The step is driven by the LABEL ITSELF, not by a hard-coded line name, so a line renamed or
  // added later gets the taller panel automatically. The threshold is in characters because that is
  // what the wrap depends on: past ~18 the label cannot fit two lines of about nine.
  const PHONE_LABEL_CHARS_PER_LINE = 9;
  const needsTallPanel = cells.some((cell) => cell.label.length > 2 * PHONE_LABEL_CHARS_PER_LINE);
  // From @md the panel is 14 squares wide, where even the longest label settles on two lines inside
  // the six-square height — so the step back down is unconditional there.
  const panelHeight = needsTallPanel ? "h-[144px] @md:h-[108px]" : "h-[108px]";

  return (
    // 🔒 THE OWNER'S OWN LAYOUT, 2026-10-03: "you will make it white, striped horizontal and vertical;
    // at the left is PHX logo watermark and the right Sato logo watermark, and the ranking centered
    // in between."
    //
    // 🔴 EYEBALLED AND REBUILT, same day — the first cut measured correctly and looked awful, and his
    // verdict was the only test that mattered. What was actually wrong, element by element:
    //
    //   · THE MARKS WERE COMPETING WITH THE DATA, not sitting behind it. The Sato mark at 16% and
    //     104px wide read as a second line of TYPE beside "6th of 35"; the colour Phoenix icon at
    //     10% went muddy grey-orange. A watermark that you notice is not a watermark. They are now
    //     4–6%, smaller, pinned into the outer margins, and the centre is reserved for the ranking.
    //   · THE GRID WAS CUTTING THROUGH THE FIGURES. At 40% over a 64px pitch a vertical hairline ran
    //     straight past "6th" and the thing read as a broken table. It is paper texture or it is
    //     nothing: 18%, and a finer 48px pitch so no single line is an event.
    //   · EVERYTHING WAS THE SAME WEIGHT — border, grid, divider, two marks, a boxed button. Premium
    //     is one hierarchy, so the FIGURES are now the only heavy thing on the plate, the divider is
    //     a short centred rule rather than a full-height one crossing the grid, and the share
    //     control is a bare glyph that only draws its box on hover.
    <section className="@container relative isolate overflow-hidden border border-[#dde4e8] bg-white">
      {/* 🔒 HIS FOOTER, 2026-10-03. He sent a finished Sato × Phoenix photo frame and said "check this
          design", then "build the rank strip in this footer's style". Everything below is that footer,
          MEASURED off the image (2000×1659) rather than eyeballed:
            · a 3px brand-blue rule on the footer's top edge;
            · a faint SQUARE grid, neutral grey, one length used twice (34px squares there);
            · SATO full colour on the left at 9.6% of the width, vertically centred;
            · the PHOENIX LOCKUP on the right at 17.5% — the bird, then PHOENIX in navy over WORKFORCE
              in orange, letter-spaced, 4px from the bird;
            · in the middle a 32×3px orange tick, 18px above a line of navy spaced capitals — the date
              there, the RANKING here.
          🔴 TWO THINGS ARE DELIBERATELY NOT COPIED, because they are the footer's two defects:
            1. its date is centred BETWEEN the logos — x=927 of 2000 — which is 73px left of the photo it
               sits under, because the lockup is 158px wider than the Sato mark. Here the two side
               columns are equal flex-1, so the ranking sits on the strip's TRUE centre;
            2. its side margins differ by 13px (138 vs 125). Here the padding is symmetric.
          🔴 And one of HIS rules overrides the reference: the area behind the ranking stays BLANK — "this
          square will be empty, no strips in it" — so the panel under the figures is opaque white. On
          the footer the date is small enough to sit on the grid; 28–34px figures are not.
          Logos are FULL COLOUR, as on his footer: the faded marks were "too pale", twice. */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-[#0879b8]" />
      {/* And its twin along the bottom edge — "put a line at the bottom as the one at the top" (owner,
          same day). Same ink, same 3px, drawn the same way: a span, because a border-t-2 here once
          computed to 1.25px under an app rule. Together they frame the strip top and bottom. */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[3px] bg-[#0879b8]" />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,#ebeef1_1px,transparent_1px),linear-gradient(to_bottom,#ebeef1_1px,transparent_1px)] bg-[length:18px_18px] bg-[position:calc(50%_+_9px)_calc(50%_+_9px)]"
      />
      <div className="relative flex items-center gap-3 px-4 pb-[calc(0.5rem+3px)] pt-[calc(0.5rem+3px)] @md:gap-6 @md:px-6">
        <div className="flex min-w-0 flex-1 justify-start">
          <img
            alt=""
            aria-hidden="true"
            className="h-auto w-[clamp(46px,11cqw,112px)] select-none"
            src="/brand/sato-pharma-logo-on-light.png"
          />
        </div>

        {/* The ranking where his footer has the date — under the same orange tick, in the same navy. */}
        <div className={`flex ${panelHeight} w-[180px] shrink-0 flex-col items-center justify-center bg-white @md:w-[252px]`}>
          <span aria-hidden="true" className="h-[3px] w-8 bg-[#f47b20]" />
          <div className="mt-3 flex items-end gap-6 @md:gap-10">
            {cells.map((cell) => (
              <div className="flex flex-col items-center" key={cell.key}>
                <p className="text-[10.5px] font-bold uppercase leading-none tracking-[0.2em] text-[#0b1f3a]">
                  {cell.label}
                </p>
                <p className="mt-2 flex items-baseline gap-1.5 whitespace-nowrap">
                  <span className={`text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums @md:text-[30px] ${cell.ink}`}>
                    {ordinal(cell.rank)}
                  </span>
                  <span className="text-phx-sm font-semibold text-[#0b1f3a]">of {cell.outOf}</span>
                </p>
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex items-center gap-1.5">
            <p className="whitespace-nowrap text-[10.5px] font-bold uppercase leading-none tracking-[0.3em] text-[#0b1f3a]">
              {standing.windowLabel}
            </p>
            {/* The one control. Bare until hovered, so it never reads as a second idea on the strip. */}
            <button
              aria-expanded={open}
              aria-label={open ? "Hide save and share" : "Save or share this as a card"}
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center border transition ${open ? "border-[#0879b8] text-[#0879b8]" : "border-transparent text-[#0b1f3a] hover:border-[#dde4e8] hover:text-[#0879b8]"}`}
              onClick={() => {
                setOpen((value) => !value);
                setNote(null);
              }}
              title={open ? "Hide save and share" : "Save or share this as a card"}
              type="button"
            >
              <Share2 className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* The Phoenix LOCKUP, as on his footer: the bird, then the two-line wordmark. Below @md there is
            no room for the words beside a ranking, so the bird carries the mark alone. */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          <span className="flex shrink-0 flex-col items-center">
            <img
              alt=""
              aria-hidden="true"
              className="h-auto w-[clamp(40px,6.5cqw,66px)] select-none"
              src="/brand/phoenix-bird-icon.png"
            />
            <span className="mt-0.5 text-[8.5px] font-extrabold leading-none tracking-[0.14em] text-[#0b1f3a] @md:hidden">
              PHOENIX
            </span>
          </span>
          <div className="hidden flex-col @md:flex">
            <span className="text-[clamp(13px,3.5cqw,24px)] font-extrabold leading-none tracking-[0.04em] text-[#0b1f3a]">
              PHOENIX
            </span>
            <span className="mt-1 text-[clamp(7px,1.5cqw,10.5px)] font-bold leading-none tracking-[0.42em] text-[#f47b20]">
              WORKFORCE
            </span>
          </div>
        </div>
      </div>

      {open && (
        <div className="relative flex flex-wrap items-center justify-center gap-1.5 border-t border-[#e8edf0] bg-[#fbfcfd] px-3 py-2">
          <button
            aria-label="Save the card as a picture"
            className="inline-flex h-[26px] items-center gap-1.5 border border-[#dde4e8] bg-white px-2 text-[10.5px] font-bold uppercase tracking-[0.2em] text-[#45515a] transition hover:border-[#f47b20] hover:text-[#f47b20] disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void save("png")}
            title="Save the card as a picture"
            type="button"
          >
            {busy === "png" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImageIcon className="h-3 w-3" />}
            Picture
          </button>
          <button
            aria-label="Save the card as a PDF"
            className="inline-flex h-[26px] items-center gap-1.5 border border-[#dde4e8] bg-white px-2 text-[10.5px] font-bold uppercase tracking-[0.2em] text-[#45515a] transition hover:border-[#0879b8] hover:text-[#0879b8] disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void save("pdf")}
            title="Save the card as a PDF"
            type="button"
          >
            {busy === "pdf" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
            PDF
          </button>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[#dde4e8]" />
          {SHARE_TARGETS.map((target) => (
            <button
              aria-label={`Share to ${target.label}`}
              className="inline-flex h-[26px] w-[26px] items-center justify-center border border-[#dde4e8] bg-white text-[#45515a] transition hover:border-[#0879b8] hover:text-[#0879b8] disabled:opacity-50"
              disabled={busy !== null}
              key={target.id}
              onClick={() => void share(target.id)}
              title={`Share to ${target.label}`}
              type="button"
            >
              {busy === target.id ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : target.id === "whatsapp-status" ? (
                // WhatsApp and WhatsApp Status share one glyph, so icon-only they were two identical
                // buttons side by side. A frame around the mark says "story" and costs no width. A
                // SQUARE tile, never a disc — SHARP rule 4: no circles as furniture.
                <span className="flex h-[18px] w-[18px] items-center justify-center border border-current">
                  <Glyph className="h-2.5 w-2.5" id={target.id} />
                </span>
              ) : (
                <Glyph className="h-3 w-3" id={target.id} />
              )}
            </button>
          ))}
        </div>
      )}
      {note && (
        <p className="relative border-t border-[#e8edf0] px-3 py-1.5 text-phx-3xs font-semibold text-[#b45309]" role="status">
          {note}
        </p>
      )}
    </section>
  );
}

/** "1st", "2nd", "3rd" … "11th", "21st". A rank reads as an ordinal. */
function ordinal(rank: number): string {
  const n = Math.trunc(rank);
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/** The clause the shared caption carries — company first, his line when that is all he holds. */
function rankClauseOf(standing: RepRankStanding | null): string | null {
  if (standing?.company) return `Ranked ${ordinal(standing.company.rank)} of ${standing.company.outOf} medical reps`;
  if (standing?.line) {
    return `Ranked ${ordinal(standing.line.rank)} of ${standing.line.outOf} in ${standing.line.lineName}`;
  }
  return null;
}
