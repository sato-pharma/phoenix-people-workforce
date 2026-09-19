"use client";

// Recruitment / ATS — the page a candidate's whole record is printed from.
//
// The owner, 2026-09-19, on the candidate page: "all data appearing here I want it printed." The sheet
// itself is built on the server (src/lib/recruitment/candidate-record-print.ts) as an HTML string with
// its own stylesheet, so the document a reader prints is one the tests and a headless browser can hold
// up and read. This component only frames it: a toolbar that is hidden on the paper, and the sheet.
//
// THE PRINT DIALOG OPENS ONCE, ON ITS OWN, a moment after the page is drawn — the same behaviour as the
// WhatsApp application (whatsapp-application-print.tsx), because both are reached from a "Print" link.
// A second print is the button. The timer, not a ref set beforehand, decides "once": React's development
// double-run of an effect clears the first timer, and a flag set before the timer would then stop the
// second one from ever being scheduled.
//
// The html and css arrive from the server, escaped there: every piece of text on the sheet went through
// escapeHtml before it was joined into markup, and nothing here adds to it.

import { Printer } from "lucide-react";
import * as React from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { CANDIDATE_RECORD_SCREEN_ONLY_CLASS } from "@/lib/recruitment/candidate-record-print-css";

/** Long enough for the sheet's first paint and the fonts, short enough that it reads as "opened to print". */
const AUTO_PRINT_DELAY_MS = 400;

export function CandidateRecordPrint({ css, html, name }: { css: string; html: string; name: string }) {
  const printed = React.useRef(false);

  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      if (printed.current) return;
      printed.current = true;
      window.print();
    }, AUTO_PRINT_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, []);

  return (
    <div className="min-h-screen bg-slate-100">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <header className={`${CANDIDATE_RECORD_SCREEN_ONLY_CLASS} sticky top-0 z-10 border-b border-slate-300 bg-white`}>
        <div className="mx-auto flex max-w-[210mm] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="break-words text-[15px] font-bold text-slate-900" dir="auto">
              {name}
            </p>
            <p className="text-[12px] text-slate-600">
              Candidate record — every section of the candidate&apos;s page. The CV is printed from its own pane.
            </p>
          </div>
          <Action onClick={() => window.print()} size="md" tone="primary">
            <Printer aria-hidden className="h-4 w-4" /> Print
          </Action>
        </div>
      </header>
      <main className="px-4 py-5">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </div>
  );
}
