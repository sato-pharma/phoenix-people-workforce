"use client";

// A paper TYPED IN BY HAND — "to be abl to manually write variable data and also fixed data auto
// populates and make sure every thing is still editable" (the owner, 2026-09-13).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THREE LAYERS, IN THE ORDER HR REACHES FOR THEM.
//   1. The boxes — the values that change from person to person. Each change redraws the paper.
//   2. The company's own details — never a box. They come from the company record, the same values
//      every record-filled paper prints, so a typed-in contract cannot name a different employer.
//   3. The paper itself — typeable anywhere, on the page, the moment it appears. Once somebody has
//      typed on the paper the boxes stop redrawing it (a redraw would wipe what they typed) and a
//      button offers to redraw on purpose.
//
// NOTHING TYPED HERE IS SAVED to anyone's record; see manual-pack.ts for why. The number is taken
// when Print is pressed, and that is the one thing kept.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { Building2, Loader2, Printer, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { issuePaperReference } from "@/components/hiring-pack/issue-paper-reference";
import { PrintOptionsDialog, type PrintAnswer } from "@/components/hiring-pack/print-options-dialog";
import { useCspNonce } from "@/components/security/csp-nonce-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { documentDefaultCopies } from "@/lib/hiring-pack/document-registry";
import type { FormsDriveEntry } from "@/lib/hiring-pack/forms-drive";
import { stampPaperReferenceInDocument } from "@/lib/hiring-pack/paper-reference";
import { documentTakesAddressChoice, type PrintAddressChoice } from "@/lib/hiring-pack/print-address";
import { withScriptNonce } from "@/lib/security/csp-nonce";

/** One box, as the manual route describes it. Mirrors `ManualPaperInput` without importing a server module. */
type ManualInput = {
  key: string;
  labelEn: string;
  kind: "text" | "date" | "money" | "number";
};

type Drawn = { ok: true; html: string; inputs: ManualInput[] } | { ok: false; message: string };

const labelClassName =
  "text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";

/** The width a paper is laid out at before it is scaled to the screen: A4 at 96dpi, with a margin. */
const DEFAULT_PAPER_WIDTH = 820;

async function drawManualPaper(body: {
  address: PrintAddressChoice | null;
  copies: string;
  document: string;
  group?: string;
  values: Record<string, string>;
  versionId: string | null;
}): Promise<Drawn> {
  try {
    const response = await fetch("/api/hiring-pack/manual", {
      body: JSON.stringify(body),
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const json = (await response.json().catch(() => null)) as
      | { html?: string; inputs?: ManualInput[]; message?: string }
      | null;
    if (!response.ok || !json || typeof json.html !== "string") {
      return { ok: false, message: json?.message ?? `Could not draw the paper (${response.status}).` };
    }
    return { ok: true, html: json.html, inputs: json.inputs ?? [] };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : "Could not draw the paper." };
  }
}

export function ManualPaperWorkspace({ entry, group }: { entry: FormsDriveEntry; group?: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [copies, setCopies] = useState(() => String(documentDefaultCopies(entry.document)));
  const [inputs, setInputs] = useState<ManualInput[]>([]);
  const [html, setHtml] = useState<string | null>(null);
  // The frame inherits the page policy, so the paper's own fitting script runs only with the page nonce
  // (src/lib/security/csp-nonce.ts). The paper is rendered by our server from escaped values.
  const nonce = useCspNonce();
  const framedHtml = useMemo(() => withScriptNonce(html ?? "", nonce), [html, nonce]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(true);
  const [printing, setPrinting] = useState(false);
  // WHICH COMPANY ADDRESS THE PAPER CARRIES, chosen in the prompt before printing (owner, 2026-09-20).
  // Null until asked, which draws the registered head office as it always did.
  const [address, setAddress] = useState<PrintAddressChoice | null>(null);
  const [asking, setAsking] = useState(false);
  const [typedOnPaper, setTypedOnPaper] = useState(false);
  const [scale, setScale] = useState(1);
  const [paperSize, setPaperSize] = useState({ height: 1123, width: DEFAULT_PAPER_WIDTH });

  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Refs as well as state: the effect below must not redraw BECAUSE a draw finished, or every draw
  // would schedule the next one.
  const typedRef = useRef(false);
  const drawnOnceRef = useRef(false);
  const requestRef = useRef(0);
  // Set when the prompt changed the count or the address: the paper is redrawn at once and printed
  // when the new page has loaded, and the debounced redraw the state change would also schedule is
  // skipped so it cannot reload the frame under an open print dialog.
  const printAfterDrawRef = useRef(false);
  const skipNextDrawRef = useRef(false);
  const printRef = useRef<() => void>(() => undefined);

  const draw = useCallback(
    async (
      nextValues: Record<string, string>,
      nextCopies: string,
      nextAddress: PrintAddressChoice | null,
    ) => {
      const id = ++requestRef.current;
      setDrawing(true);
      const result = await drawManualPaper({
        address: nextAddress,
        copies: nextCopies,
        document: entry.document,
        group,
        values: nextValues,
        versionId: entry.versionId,
      });
      // A slower, older draw must never land on top of a newer one.
      if (id !== requestRef.current) return;
      setDrawing(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      drawnOnceRef.current = true;
      typedRef.current = false;
      setError(null);
      setTypedOnPaper(false);
      setHtml(result.html);
      setInputs(result.inputs);
    },
    [entry.document, entry.versionId, group],
  );

  useEffect(() => {
    if (skipNextDrawRef.current) {
      skipNextDrawRef.current = false;
      return;
    }
    if (typedRef.current) return;
    // The first draw is immediate — it is what lists the boxes. After that, wait for a pause in
    // the typing rather than drawing the paper once per keystroke.
    const timer = window.setTimeout(
      () => void draw(values, copies, address),
      drawnOnceRef.current ? 600 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [address, copies, draw, values]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // The paper keeps its printed layout and is SCALED to fit, so a phone shows the whole sheet
    // rather than a sideways scroll across it.
    const observer = new ResizeObserver(() => {
      const next = Math.min(1, box.clientWidth / paperSize.width);
      setScale((current) => (Math.abs(current - next) < 0.005 ? current : next));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [paperSize.width]);

  const onFrameLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    // Everything on the paper is typeable, straight away — "make sure every thing is still editable".
    doc.designMode = "on";
    doc.addEventListener("input", () => {
      typedRef.current = true;
      setTypedOnPaper(true);
    });
    setPaperSize({
      height: Math.max(400, doc.documentElement.scrollHeight),
      width: Math.max(DEFAULT_PAPER_WIDTH, doc.documentElement.scrollWidth),
    });
    // The prompt redrew the paper for a new count or address: it is on screen now, so print it.
    if (printAfterDrawRef.current) {
      printAfterDrawRef.current = false;
      printRef.current();
    }
  }, []);

  const print = useCallback(async () => {
    const frame = frameRef.current;
    if (!frame?.contentWindow || !frame.contentDocument) return;
    setPrinting(true);
    const reference = await issuePaperReference({
      copies: Number.parseInt(copies, 10) || 1,
      document: entry.document,
      documentLabel: entry.label,
      mode: "manual",
      subjectName: values["employee.nameAr"]?.trim() || values["employee.fullName"]?.trim() || null,
    });
    stampPaperReferenceInDocument(frame.contentDocument, reference, entry.document);
    setPrinting(false);
    if (!reference) {
      setNotice("The paper register is not set up yet, so this paper printed without a number.");
    } else if (entry.numberOnFace) {
      setNotice(`Numbered ${reference}. The number is on the paper and in the register.`);
    } else {
      setNotice(
        `Numbered ${reference} in the register. This is an official form, so it prints exactly as issued, with no number on it.`,
      );
    }
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }, [copies, entry.document, entry.label, entry.numberOnFace, values]);

  useEffect(() => {
    printRef.current = () => void print();
  }, [print]);

  /**
   * The prompt's answer. Nothing has printed yet: the count and the address are applied to the
   * paper first, because both are WRITTEN ON IT — and printing the page as it stands would hand over
   * a paper that says something different from what was just chosen.
   */
  const confirmPrint = useCallback(
    async (answer: PrintAnswer) => {
      setAsking(false);
      const nextCopies = String(answer.copies);
      const nextAddress = answer.address ?? address;
      const changed = nextCopies !== copies || nextAddress !== address;
      if (!changed) {
        void print();
        return;
      }
      if (typedRef.current) {
        // A redraw would wipe what was typed on the paper, and printing it as it stands would carry
        // the old count and address. So neither happens: say so, and let the desk choose.
        setError(
          "You typed on the paper, so a different number of copies or company address cannot be applied without redrawing it. Use “Apply the boxes to the paper” first (that replaces what you typed), then print again.",
        );
        return;
      }
      skipNextDrawRef.current = true;
      printAfterDrawRef.current = true;
      setCopies(nextCopies);
      setAddress(nextAddress);
      await draw(values, nextCopies, nextAddress);
    },
    [address, copies, draw, print, values],
  );

  return (
    <div className="flex flex-col gap-4">
      {asking ? (
        <PrintOptionsDialog
          askAddress={documentTakesAddressChoice(entry.document)}
          defaultCopies={Number.parseInt(copies, 10) >= 1 ? Number.parseInt(copies, 10) : 1}
          initialAddress={address}
          onCancel={() => setAsking(false)}
          onConfirm={(answer) => void confirmPrint(answer)}
          registeredAddress={null}
          title={entry.label}
        />
      ) : null}
      <div className="flex items-start gap-3 border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-phx-ink-soft">
        <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-phx-accent-press" />
        <p>
          Type the details that change from person to person. The company&apos;s own details (name,
          address, register numbers and signatory) fill themselves in from the company record. Once
          the paper appears you can also type anywhere on it. Nothing typed here is saved to an
          employee&apos;s record.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {inputs.map((input) => (
          <label className="flex min-w-0 flex-col gap-1.5" key={input.key}>
            <span className={labelClassName}>{input.labelEn}</span>
            <Input
              className="h-10"
              dir={input.kind === "text" ? "auto" : "ltr"}
              inputMode={input.kind === "money" || input.kind === "number" ? "decimal" : undefined}
              onChange={(event) => {
                const next = event.target.value;
                setValues((current) => ({ ...current, [input.key]: next }));
              }}
              type={input.kind === "date" ? "date" : "text"}
              value={values[input.key] ?? ""}
            />
          </label>
        ))}
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClassName}>Copies</span>
          <Input
            className="h-10"
            dir="ltr"
            max={20}
            min={1}
            onChange={(event) => setCopies(event.target.value)}
            type="number"
            value={copies}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="gap-2 rounded-none"
          disabled={printing || drawing || html === null}
          onClick={() => setAsking(true)}
          type="button"
        >
          {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
          {printing ? "Numbering" : "Print"}
        </Button>
        {typedOnPaper ? (
          <Button
            className="gap-2 rounded-none"
            disabled={drawing}
            onClick={() => {
              typedRef.current = false;
              void draw(values, copies, address);
            }}
            type="button"
            variant="outline"
          >
            <RefreshCw className="h-4 w-4" />
            Apply the boxes to the paper
          </Button>
        ) : null}
        {drawing ? (
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-phx-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> Drawing the paper
          </span>
        ) : null}
        {typedOnPaper ? (
          <span className="text-sm text-phx-ink-soft">
            You typed on the paper, so the boxes no longer redraw it. Applying them replaces what you typed.
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>
      ) : null}
      {notice ? (
        <p className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>
      ) : null}

      <div className="w-full overflow-hidden border border-slate-200 bg-slate-100" ref={boxRef}>
        <div style={{ height: html === null ? 240 : paperSize.height * scale }}>
          {html !== null ? (
            <iframe
              className="block bg-white"
              onLoad={onFrameLoad}
              ref={frameRef}
              srcDoc={framedHtml}
              style={{
                border: 0,
                height: paperSize.height,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                width: paperSize.width,
              }}
              title={`${entry.label}, typed in by hand`}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
