"use client";

import { Camera, Loader2, Trash2, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

// HR/Admin control to set or clear any employee's profile photo. Self-contained:
// it tries the uploaded-photo route first and falls back (onError) to the bundled
// static photo, then initials — so it needs no server-side photo lookup.
export function EmployeePhotoManager({ hrId, fullName }: { hrId: string; fullName: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const staticUrl = employeeProfileImageForHrId(hrId);
  const initials =
    fullName
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase() || "EM";

  const [mode, setMode] = useState<"uploaded" | "static" | "initials">("uploaded");
  const [bust, setBust] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const endpoint = `/api/employees/${encodeURIComponent(hrId)}/photo`;
  const uploadedSrc = `${endpoint}?v=${bust}`;
  const displaySrc =
    preview ?? (mode === "uploaded" ? uploadedSrc : mode === "static" ? staticUrl : null);
  const hasVisiblePhoto = mode === "uploaded" && !preview;

  function handleImageError() {
    if (preview) return;
    setMode((current) => (current === "uploaded" ? (staticUrl ? "static" : "initials") : "initials"));
  }

  async function handleFile(file: File) {
    setError(null);
    if (!ACCEPTED.includes(file.type)) {
      setError("Please choose a JPG, PNG, or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That image is larger than 5 MB.");
      return;
    }
    const localPreview = URL.createObjectURL(file);
    setPreview(localPreview);
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(endpoint, { method: "POST", body: formData });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "Upload failed. Please try again.");
      }
      setMode("uploaded");
      setBust((n) => n + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setPreview(null);
      setBusy(false);
      URL.revokeObjectURL(localPreview);
    }
  }

  async function handleRemove() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "Could not remove the photo.");
      }
      setMode(staticUrl ? "static" : "initials");
      setBust((n) => n + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the photo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4 rounded border border-phx-line bg-phx-paper p-4">
      <div className="relative flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded border border-orange-100 bg-white shadow-sm">
        {displaySrc ? (
          // Same reason as the portal editor: a 72px hard crop is not enough to check a photo
          // before it goes out across Phoenix. It was already `unoptimized`.
          <ZoomablePhoto
            alt={`${fullName} profile photo`}
            caption={`${fullName} · profile photo`}
            className="h-full w-full object-cover object-[center_18%]"
            onError={handleImageError}
            src={displaySrc}
          />
        ) : (
          <span className="text-xl font-black tracking-tight text-orange-500">{initials}</span>
        )}
        {busy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
          </div>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-phx-ink">Profile photo</p>
        <p className="mt-0.5 text-xs text-phx-ink-soft">JPG, PNG, or WebP, up to 5&nbsp;MB. Updates everywhere.</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            className="inline-flex items-center gap-2 rounded bg-orange-500 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.06em] text-white shadow-sm transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {hasVisiblePhoto ? <Camera className="h-3.5 w-3.5" /> : <UploadCloud className="h-3.5 w-3.5" />}
            {hasVisiblePhoto ? "Change photo" : "Upload photo"}
          </button>
          {hasVisiblePhoto ? (
            <button
              className="inline-flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.06em] text-phx-ink-soft shadow-sm transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busy}
              onClick={handleRemove}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </button>
          ) : null}
        </div>
        {error ? <p className="mt-2 text-xs font-semibold text-rose-600">{error}</p> : null}
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
