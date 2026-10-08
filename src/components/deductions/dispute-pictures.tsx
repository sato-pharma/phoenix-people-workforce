"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";

import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { DISPUTE_ATTACHMENT_MAX_FILES } from "@/lib/deductions/comment-attachment-rules.ts";
import type { DeductionsCommentAttachment } from "@/lib/deductions/types.ts";

/**
 * Pictures on a deduction dispute reply — the two halves a person sees (owner, 2026-10-08):
 *
 *  - `PicturePicker` is the sender's side: choose pictures, see them before sending, remove one.
 *  - `PictureStrip` is the reader's side, in the admin Disputes tab and the employee's portal alike.
 *
 * A phone photo is several megabytes, so each chosen picture is shrunk in the browser first (longest
 * side 1,600 px, JPEG) — the upload stays small and fast on a mobile connection, and the server's own
 * 5 MB per-picture limit is never the thing the sender runs into. The layout fits any width: the
 * thumbnails wrap, they never scroll sideways, and every corner is square.
 */

const LONGEST_SIDE_PX = 1600;
/** Already small enough to send as chosen. */
const LEAVE_ALONE_BYTES = 600 * 1024;

/** Shrink one picture for upload. Throws a sentence the sender can act on when the browser cannot read it. */
async function shrinkPicture(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    throw new Error(`${file.name || "A file"} is not a JPEG, PNG or WebP picture.`);
  }
  if (file.size <= LEAVE_ALONE_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONGEST_SIDE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size === 0) throw new Error("no blob");
    // Only keep the smaller of the two: a tiny PNG screenshot can grow when re-encoded as JPEG.
    if (blob.size >= file.size) return file;
    const base = (file.name || "picture").replace(/\.[^.]+$/, "");
    return new File([blob], `${base}.jpg`, { lastModified: Date.now(), type: "image/jpeg" });
  } catch {
    // The browser could not decode it; send it as chosen if it already fits, else say so.
    if (file.size <= 4 * 1024 * 1024) return file;
    throw new Error(`${file.name || "A picture"} could not be reduced. Choose a smaller picture.`);
  }
}

export function PicturePicker({
  disabled,
  files,
  idBase,
  onChange,
}: {
  disabled?: boolean;
  files: File[];
  idBase: string;
  onChange: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // Object URLs for the previews, released when the list changes or the picker goes away.
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);

  async function addChosen(list: FileList | null) {
    if (!list || list.length === 0) return;
    setProblem(null);
    setWorking(true);
    try {
      const next = [...files];
      for (const chosen of Array.from(list)) {
        if (next.length >= DISPUTE_ATTACHMENT_MAX_FILES) {
          setProblem(`A reply can carry at most ${DISPUTE_ATTACHMENT_MAX_FILES} pictures.`);
          break;
        }
        try {
          next.push(await shrinkPicture(chosen));
        } catch (caught) {
          setProblem(caught instanceof Error ? caught.message : "That picture could not be added.");
        }
      }
      onChange(next);
    } finally {
      setWorking(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const full = files.length >= DISPUTE_ATTACHMENT_MAX_FILES;

  return (
    <div className="mt-3">
      <input
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        disabled={disabled || working || full}
        id={`${idBase}-pictures`}
        multiple
        onChange={(event) => {
          void addChosen(event.target.files);
        }}
        ref={inputRef}
        type="file"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label
          className={`${phxButtonGhostClassName} cursor-pointer ${disabled || working || full ? "pointer-events-none opacity-40" : ""}`}
          htmlFor={`${idBase}-pictures`}
        >
          <ImagePlus aria-hidden className="h-4 w-4" />
          {working ? "Preparing" : "Add pictures"}
        </label>
        <span className="text-xs font-semibold text-slate-400">
          {files.length} / {DISPUTE_ATTACHMENT_MAX_FILES} · JPEG, PNG or WebP
        </span>
      </div>
      {files.length > 0 ? (
        <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
          {files.map((file, index) => (
            <li className="relative border border-slate-300 bg-white" key={`${file.name}-${file.size}-${index}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={file.name} className="aspect-square w-full object-cover" src={previews[index]} />
              <button
                aria-label={`Remove ${file.name}`}
                className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                disabled={disabled}
                onClick={() => onChange(files.filter((_, at) => at !== index))}
                type="button"
              >
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <p className="mt-2 text-xs font-semibold text-rose-700" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The pictures on one message, as thumbnails that open the full picture in a new tab. */
export function PictureStrip({ attachments }: { attachments: DeductionsCommentAttachment[] | undefined }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
      {attachments.map((picture) => (
        <li className="border border-slate-300 bg-white" key={picture.id}>
          <a href={picture.url} rel="noopener" target="_blank" title={picture.fileName}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt={picture.fileName} className="aspect-square w-full object-cover" loading="lazy" src={picture.url} />
          </a>
        </li>
      ))}
    </ul>
  );
}
