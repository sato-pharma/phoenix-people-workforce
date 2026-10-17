"use client";

import { useRef, useState } from "react";
import { Check, Copy, Lock, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

// The employee's own email signature: ONE picture built from their record (the Sato Pharma and Phoenix
// Workforce signature), a Copy button, and the steps for each mail app. The picture is one object on
// purpose — pasted into a signature box, it can only be removed whole, never edited piece by piece
// (owner, 2026-10-17). The page cannot change what the mail app does with it, so the promise is made
// by the shape of the thing: there are no separate logo, phone or email parts to delete.

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Step = { app: string; steps: string[] };

const STEPS: Step[] = [
  {
    app: "Gmail",
    steps: [
      "Click Copy my signature above.",
      "In Gmail, click the gear icon, then See all settings.",
      "Stay on the General tab and scroll down to Signature, then click Create new.",
      "Name it Phoenix, click inside the box, and press Ctrl + V to paste.",
      "Under Signature defaults, choose it for New emails and for Reply/forward.",
      "Scroll to the bottom and click Save Changes.",
    ],
  },
  {
    app: "Outlook on the web and the new Outlook",
    steps: [
      "Click Copy my signature above.",
      "Click the gear icon, then Accounts, then Signatures.",
      "Click New signature, name it Phoenix, click inside the box and press Ctrl + V.",
      "Tick the two boxes that use it for new messages and for replies and forwards.",
      "Click Save.",
    ],
  },
  {
    app: "Outlook for Windows (the classic app)",
    steps: [
      "Click Copy my signature above.",
      "In Outlook, click File, then Options, then Mail, then Signatures.",
      "Click New, name it Phoenix, click inside the big box at the bottom and press Ctrl + V.",
      "On the right, choose it for New messages and for Replies/forwards.",
      "Click OK.",
    ],
  },
  {
    app: "Apple Mail",
    steps: [
      "Click Copy my signature above.",
      "In Mail, open Settings, then Signatures, and click the + button.",
      "Untick Always match my default message font, click inside the box and press Cmd + V.",
      "Drag the signature onto your account name on the left.",
    ],
  },
];

export function EmailSignatureMaker({
  alt,
  height,
  imagePath,
  linkUrl,
  nameHasUnprintableCharacters,
  productionOrigin,
  width,
}: {
  alt: string;
  height: number;
  imagePath: string;
  linkUrl: string;
  nameHasUnprintableCharacters: boolean;
  productionOrigin: string;
  width: number;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // What lands on the clipboard: the picture, linked to Phoenix, by its ABSOLUTE address — a mail app
  // cannot reach a relative one. One link around one picture is the whole signature.
  const html =
    `<a href="${escapeAttribute(linkUrl)}"><img src="${escapeAttribute(`${productionOrigin}${imagePath}`)}" ` +
    `width="${width}" height="${height}" alt="${escapeAttribute(alt)}" style="display:block;border:0;"></a>`;

  function copyBySelection(): boolean {
    const node = previewRef.current;
    if (!node) return false;
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNode(node);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      return document.execCommand("copy");
    } finally {
      selection.removeAllRanges();
    }
  }

  async function copy() {
    setProblem(null);
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([linkUrl], { type: "text/plain" }),
          }),
        ]);
      } else if (!copyBySelection()) {
        throw new Error("copy refused");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4000);
    } catch {
      if (copyBySelection()) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 4000);
      } else {
        setProblem("Your browser would not copy it. Click the signature below once, press Ctrl + C, and paste as usual.");
      }
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="border border-phx-line bg-phx-paper p-4 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Your signature</p>
          <Button className="h-9 rounded-none" onClick={() => void copy()} size="sm" type="button">
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied — now paste it" : "Copy my signature"}
          </Button>
        </div>

        <div className="border border-slate-300 bg-white p-3 sm:p-5">
          <div className="w-fit max-w-full" ref={previewRef}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the picture IS the product: a mail app fetches this exact file. */}
            <img alt={alt} className="block h-auto max-w-full" height={height} src={imagePath} width={width} />
          </div>
        </div>

        {problem ? (
          <p className="mt-2 text-phx-sm font-semibold text-rose-700" role="status">
            {problem}
          </p>
        ) : null}
        {nameHasUnprintableCharacters ? (
          <p className="mt-3 flex items-start gap-2 text-phx-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            Some letters in your record are not English letters, so the picture leaves them out. Ask HR to write
            them in English letters on your record.
          </p>
        ) : null}
        <p className="mt-3 flex items-start gap-2 text-phx-xs text-phx-ink-soft">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          It is one picture, so it stays whole: you cannot delete the Phoenix logo, the Sato logo or a phone number
          on their own — removing any part removes the entire signature. Everything on it comes from your record, so
          a correction made by HR reaches your emails by itself.
        </p>
      </section>

      <section className="border border-slate-200/90 bg-white/95 p-4 sm:p-6">
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">How to add it</p>
        <p className="mt-1 text-sm font-semibold text-phx-ink-soft">
          Copy it once, then follow the steps for the app you write your emails in.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {STEPS.map((entry) => (
            <div className="min-w-0 border border-phx-line p-4" key={entry.app}>
              <h3 className="text-sm font-black text-phx-ink">{entry.app}</h3>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-phx-ink-soft">
                {entry.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
        <p className="mt-4 text-phx-xs text-phx-ink-soft">
          If a person&apos;s mail app hides pictures until they allow them, they see your name, title and contact
          details written out in place of the picture.
        </p>
      </section>
    </div>
  );
}
