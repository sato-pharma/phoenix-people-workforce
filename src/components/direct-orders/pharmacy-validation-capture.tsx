"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";

type Props = {
  pharmacyId: string;
  pharmacyName: string;
  requestId?: string | null;
  onDone?: () => void;
};

type Capture = {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  capturedAt: string | null;
  address: string | null;
};

const EMPTY: Capture = { latitude: null, longitude: null, accuracy: null, capturedAt: null, address: null };

type Suggestion = {
  distributorCode: string;
  customerCode: string;
  customerName: string;
  address: string | null;
  areaCode: string | null;
  score: number;
};

/**
 * Pharmacy Validation evidence capture (spec A2 — docs/specs/direct-orders-v2.md).
 *
 * Deliberately the same shape as the marketing Customer Validation capture staff already use every
 * week: GPS first, then a live camera frame, with the coordinates and timestamp BURNED INTO the
 * image. Burning the stamp matters — the pixels then carry their own provenance, so the evidence
 * survives being screenshotted, forwarded, or pasted into a chat, and a photo taken somewhere else
 * cannot be relabelled later.
 *
 * There is no file picker anywhere in this component, and that is the point: the server rejects
 * anything that is not a live JPEG, so offering an upload button would only teach reps to try.
 */
export function PharmacyValidationCapture({ pharmacyId, pharmacyName, requestId, onDone }: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [capture, setCapture] = useState<Capture>(EMPTY);
  const [photo, setPhoto] = useState<string | null>(null);
  const [name, setName] = useState(pharmacyName);
  const [address, setAddress] = useState("");
  const [doctor, setDoctor] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // "Did you mean…" as the rep types the name. This is the cheapest possible moment to prevent a
  // phantom: most "new" pharmacies are real ones spelled differently, and a rep who recognises the
  // real one here never reaches the evidence step at all. Phoenix speaks in its own voice — the
  // matching is trigram similarity, and nothing here announces a mechanism (owner rule D4).
  useEffect(() => {
    const term = name.trim();
    let cancelled = false;
    // EVERY setState lives inside the scheduled callback, never in the effect body — the repo's
    // react-hooks/set-state-in-effect rule. The clear path is a 0ms timeout for the same reason.
    const timer = setTimeout(
      async () => {
        if (cancelled) return;
        if (term.length < 3) {
          setSuggestions([]);
          return;
        }
        try {
          const res = await fetch(`/api/direct-orders/pharmacy-suggestions?name=${encodeURIComponent(term)}`);
          const data = (await res.json().catch(() => ({}))) as { rows?: Suggestion[] };
          if (!cancelled) setSuggestions(Array.isArray(data.rows) ? data.rows : []);
        } catch {
          if (!cancelled) setSuggestions([]);
        }
      },
      term.length < 3 ? 0 : 350,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name]);

  async function startCamera() {
    setError(null);
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
      setMessage("Camera ready. Point at the pharmacy sign.");
    } catch (cameraError) {
      const name = cameraError instanceof DOMException ? cameraError.name : "CameraError";
      setError(
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Camera permission is blocked. Allow it for this site, then retry."
          : name === "NotFoundError"
            ? "No camera was found on this device."
            : `Camera access failed: ${name}.`,
      );
    }
  }

  function captureLocation() {
    setError(null);
    if (!navigator.geolocation) {
      setError("This device cannot provide a location.");
      return;
    }
    setMessage("Getting your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCapture({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
          address: `${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`,
        });
        setMessage("Location captured. Now take the photo.");
      },
      () => setError("Location capture failed. Allow location access and try again."),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  }

  function takePhoto() {
    const video = videoRef.current;
    if (!cameraReady || !video || video.videoWidth === 0) {
      setError("Start the camera first.");
      return;
    }
    // GPS BEFORE the shutter, deliberately: a photo with no coordinates is not evidence of a
    // place, and letting it be taken first would invite "I'll add the location after".
    if (capture.latitude == null) {
      setError("Capture your location before taking the photo.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const takenAt = new Date().toISOString();
    const fontSize = Math.max(16, Math.round(canvas.width * 0.022));
    const lineHeight = Math.round(fontSize * 1.38);
    const pad = Math.round(fontSize * 0.75);
    const lines = [
      "Pharmacy validation live evidence",
      `Photo date/time: ${takenAt}`,
      `GPS: ${capture.latitude?.toFixed(6)}, ${capture.longitude?.toFixed(6)}${capture.accuracy ? ` (accuracy ${Math.round(capture.accuracy)}m)` : ""}`,
      `GPS captured at: ${capture.capturedAt}`,
    ];
    const boxHeight = lines.length * lineHeight + pad * 2;
    ctx.fillStyle = "rgba(15,23,42,0.72)";
    ctx.fillRect(0, canvas.height - boxHeight, canvas.width, boxHeight);
    ctx.fillStyle = "#ffffff";
    ctx.font = `${fontSize}px Arial, Helvetica, sans-serif`;
    lines.forEach((line, i) => {
      ctx.fillText(line, pad, canvas.height - boxHeight + pad + lineHeight * (i + 1) - Math.round(lineHeight * 0.28));
    });

    setPhoto(canvas.toDataURL("image/jpeg", 0.86));
    setMessage("Photo captured.");
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setCameraReady(false);
  }

  async function submit() {
    setError(null);
    if (!photo) return setError("Take the storefront photo.");
    if (!name.trim()) return setError("Pharmacy name is required.");
    if (!reason.trim()) return setError("Say why this pharmacy is not in the master database.");
    setBusy(true);
    try {
      const res = await fetch("/api/direct-orders/pharmacy-validations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pharmacyId,
          requestId: requestId ?? null,
          claimedPharmacyName: name.trim(),
          claimedAddress: address.trim() || null,
          claimedDoctorName: doctor.trim() || null,
          claimedReason: reason.trim(),
          photoDataUrl: photo,
          capturedLatitude: capture.latitude,
          capturedLongitude: capture.longitude,
          capturedAccuracyMeters: capture.accuracy,
          capturedAt: capture.capturedAt,
          capturedAddress: capture.address,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not submit the validation.");
      setMessage("Sent for validation. Your order stays on hold until it is reviewed.");
      setPhoto(null);
      onDone?.();
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "mt-1 w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none";
  const labelClass = "block text-[11px] font-black uppercase tracking-wider text-slate-500";

  return (
    <section className="border border-[#e4e9ec] bg-white">
      <header className="border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">Validate this pharmacy</h3>
      </header>
      <div className="space-y-3 px-4 py-4">
        <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-900">
          This pharmacy is not in the master database. To move your order, capture your location and
          a live photo of the pharmacy sign. A System Admin reviews it.
        </p>

        <div>
          <label className={labelClass}>Pharmacy name *</label>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
          {suggestions.length > 0 ? (
            <div className="mt-2 border border-sky-300 bg-sky-50 px-3 py-2">
              <p className="text-[12px] font-black text-sky-900">
                Phoenix already knows {suggestions.length === 1 ? "a pharmacy" : "pharmacies"} with a similar name:
              </p>
              <ul className="mt-1 space-y-1">
                {suggestions.map((s) => (
                  <li key={`${s.distributorCode}:${s.customerCode}`} className="text-[12px] text-slate-700">
                    <span className="font-bold" dir="auto">{s.customerName}</span>
                    <span className="text-slate-500"> — {s.distributorCode} · {s.customerCode}</span>
                    {s.areaCode ? <span className="text-slate-400"> · {s.areaCode}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] font-semibold text-sky-800">
                If one of these is your pharmacy, go back and pick it — your order goes through
                immediately with no validation needed.
              </p>
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className={labelClass}>Address</label>
            <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} dir="auto" />
          </div>
          <div>
            <label className={labelClass}>Doctor / owner</label>
            <input className={inputClass} value={doctor} onChange={(e) => setDoctor(e.target.value)} dir="auto" />
          </div>
        </div>
        <div>
          <label className={labelClass}>Why is it not in the master database? *</label>
          <textarea
            className={inputClass}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="New pharmacy, hospital, nursery, deals with no distributor…"
            dir="auto"
          />
        </div>

        <div className="border border-[#eef1f3] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={captureLocation} className="border border-slate-300 px-3 py-1.5 text-[12px] font-bold text-slate-700 hover:bg-slate-50">
              1. Capture location
            </button>
            <button type="button" onClick={startCamera} className="border border-slate-300 px-3 py-1.5 text-[12px] font-bold text-slate-700 hover:bg-slate-50">
              2. Start camera
            </button>
            <button type="button" onClick={takePhoto} disabled={!cameraReady} className="bg-slate-900 px-3 py-1.5 text-[12px] font-bold text-white disabled:bg-slate-400">
              3. Take photo
            </button>
          </div>
          {capture.latitude != null ? (
            <p className="mt-2 text-[11px] font-semibold text-emerald-700">
              Location: {capture.latitude.toFixed(6)}, {capture.longitude?.toFixed(6)}
              {capture.accuracy ? ` (±${Math.round(capture.accuracy)}m)` : ""}
            </p>
          ) : null}
          <video ref={videoRef} playsInline muted className={`mt-2 w-full max-w-md border border-slate-200 ${cameraReady ? "" : "hidden"}`} />
          {photo ? (
            <ZoomablePhoto
              alt="Storefront evidence"
              caption="Storefront evidence"
              className="mt-2 w-full max-w-md border border-emerald-300"
              src={photo}
            />
          ) : null}
        </div>

        {message ? <p className="text-[12px] font-semibold text-slate-600">{message}</p> : null}
        {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

        <button
          type="button"
          onClick={submit}
          disabled={busy || !photo}
          className="w-full bg-orange-500 px-4 py-2.5 text-[13px] font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {busy ? "Sending…" : "Send for validation"}
        </button>
      </div>
    </section>
  );
}
