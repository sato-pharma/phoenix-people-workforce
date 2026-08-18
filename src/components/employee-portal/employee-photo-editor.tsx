"use client";

import { Camera, Loader2, Trash2, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

export function EmployeePhotoEditor({
  currentPhotoUrl,
  hasUploadedPhoto,
  fullName,
  initials,
}: {
  currentPhotoUrl: string | null;
  hasUploadedPhoto: boolean;
  fullName: string;
  initials: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const displaySrc = preview ?? currentPhotoUrl;
  const showRemove = hasUploadedPhoto && !preview;

  async function handleFile(file: File) {
    setError(null);
    if (!ACCEPTED.includes(file.type)) {
      setError("Please choose a JPG, PNG, or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That image is larger than 5 MB. Please choose a smaller one.");
      return;
    }

    const localPreview = URL.createObjectURL(file);
    setPreview(localPreview);
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/employee-portal/profile-photo", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "Upload failed. Please try again.");
      }
      router.refresh();
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
      URL.revokeObjectURL(localPreview);
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/employee-portal/profile-photo", { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "Could not remove the photo.");
      }
      setPreview(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the photo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
          Profile photo
        </span>
        <span className="text-[11px] font-medium text-slate-400">Shown across Phoenix</span>
      </div>

      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
        <div className="group relative flex h-[92px] w-[92px] shrink-0 items-center justify-center overflow-hidden rounded border border-orange-100 bg-gradient-to-tr from-orange-50/80 to-white shadow-[0_10px_28px_rgba(249,115,22,0.12)]">
          {displaySrc ? (
            // Not next/image any more: this frame hard-crops a portrait to 92px at
            // `object-[center_18%]`, so what the employee is actually approving is a sliver of
            // their own photo. Tapping it shows the whole frame. The optimizer bought nothing here
            // anyway — blob previews and the same-origin photo route were already `unoptimized`.
            <ZoomablePhoto
              alt={`${fullName} profile photo`}
              caption={`${fullName} · profile photo`}
              className="h-full w-full object-cover object-[center_18%]"
              src={displaySrc}
            />
          ) : (
            <span className="text-[28px] font-black tracking-tight text-orange-500">
              {initials || "EM"}
            </span>
          )}
          {busy ? (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70">
              <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
            </div>
          ) : null}
        </div>

        <div className="min-w-0 flex-1 text-center sm:text-left">
          <p className="text-sm font-bold text-slate-900">Update your photo</p>
          <p className="mt-1 text-xs text-slate-500">
            JPG, PNG, or WebP, up to 5&nbsp;MB. Your new photo replaces the old one everywhere
            instantly.
          </p>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
            <button
              className="inline-flex items-center gap-2 rounded bg-orange-500 px-3.5 py-2 text-xs font-bold uppercase tracking-[0.08em] text-white shadow-sm transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              {hasUploadedPhoto ? <Camera className="h-3.5 w-3.5" /> : <UploadCloud className="h-3.5 w-3.5" />}
              {hasUploadedPhoto ? "Change photo" : "Upload photo"}
            </button>
            {showRemove ? (
              <button
                className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold uppercase tracking-[0.08em] text-slate-600 shadow-sm transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={busy}
                onClick={handleRemove}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            ) : null}
          </div>

          {error ? (
            <p className="mt-2 text-xs font-semibold text-rose-600">{error}</p>
          ) : null}
        </div>
      </div>

      <input
        accept={ACCEPTED.join(",")}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          event.target.value = "";
        }}
        ref={inputRef}
        type="file"
      />
    </div>
  );
}
