"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildEvidenceStampLines,
  resolveEvidenceLocationStamp,
  wrapWatermarkText,
  type ResolvedEvidenceLocation,
} from "@/components/outstation/evidence-watermark";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import {
  PHARMACY_LICENSE_ACCEPT_ATTRIBUTE,
  PHARMACY_LICENSE_MAX_BYTES,
  isPharmacyLicenseContentType,
  pharmacyLicenseFillsTheIdentityGap,
  pharmacyLicensePrompt,
} from "@/lib/venues/pharmacy-license";
import { DEFAULT_VENUE_TYPE, type VenueType } from "@/lib/venues/venue-type";
import { VENUE_LOCATION_REQUIRED_MESSAGE } from "@/lib/venues/venue-validation-rule";

type Props = {
  pharmacyId: string;
  pharmacyName: string;
  requestId?: string | null;
  /**
   * How many distributor codes this pharmacy holds, and what kind of venue it is. Both come from
   * the order detail the page already loaded, and together they decide whether the pharmacy licence
   * is the proof this venue is actually short of — see `pharmacyLicenseFillsTheIdentityGap`.
   *
   * Defaulted so the two pages that mount this could not silently start prompting for a licence on
   * every venue if one of them ever forgets to pass them.
   */
  distributorCodeCount?: number;
  venueType?: VenueType;
  onDone?: () => void;
};

type Capture = {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  capturedAt: string | null;
  address: string | null;
  /** The full evidence stamp — address, Phoenix brick/area/region, coordinates. */
  location: ResolvedEvidenceLocation | null;
};

const EMPTY: Capture = {
  latitude: null,
  longitude: null,
  accuracy: null,
  capturedAt: null,
  address: null,
  location: null,
};

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
 * The STOREFRONT photo has no file picker, and that is the point: the server rejects anything that
 * is not a live JPEG, so offering an upload button there would only teach reps to try.
 *
 * The pharmacy LICENCE below it is the deliberate exception, and the difference is what each one
 * claims. The storefront photo claims "taken at this place, at this time"; the licence claims only
 * "this is the document", and it usually arrives as a scan or a PDF from the pharmacist rather than
 * being on the wall to photograph. Owner's call, 2026-08-25 — see `src/lib/venues/pharmacy-license.ts`.
 */
export function PharmacyValidationCapture({
  pharmacyId,
  pharmacyName,
  requestId,
  distributorCodeCount = 0,
  venueType = DEFAULT_VENUE_TYPE,
  onDone,
}: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const licenseCameraRef = useRef<HTMLInputElement | null>(null);
  const licenseFileRef = useRef<HTMLInputElement | null>(null);

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
  const [license, setLicense] = useState<{ dataUrl: string; fileName: string; isPdf: boolean } | null>(null);

  const licenseFillsTheGap = pharmacyLicenseFillsTheIdentityGap({ distributorCodeCount, venueType });
  const licenseNote = pharmacyLicensePrompt({
    distributorCodeCount,
    hasLicenseOnFile: Boolean(license),
    venueType,
  });

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

  /**
   * GPS, then the readable place, then the shutter unlocks.
   *
   * The address and territory are resolved HERE rather than at photo time on purpose: `takePhoto`
   * is synchronous and guards on `capture.latitude`, so writing the coordinates before the lookup
   * finishes would let a rep shoot a photo captioned with a half-resolved location. Nothing is
   * written into state until the whole stamp exists.
   */
  function captureLocation() {
    setError(null);
    if (!navigator.geolocation) {
      setError("This device cannot provide a location.");
      return;
    }
    setMessage("Getting your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const capturedAt = new Date(position.timestamp || Date.now()).toISOString();
        setMessage("Location captured. Resolving the address…");
        void resolveEvidenceLocationStamp(
          "/api/direct-orders/reverse-geocode",
          position.coords.latitude,
          position.coords.longitude,
          position.coords.accuracy ?? null,
        ).then((location) => {
          setCapture({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            capturedAt,
            address: location.label,
            location,
          });
          setMessage("Location captured. Now take the photo.");
        });
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
    // Same wording as every other Phoenix evidence photo: full address, then the Phoenix brick,
    // area and region, then the coordinates as fine print. Owner instruction 2026-08-23 — a bare
    // latitude/longitude tells an approver nothing about whether this is the right pharmacy.
    const captions = buildEvidenceStampLines({
      capturedAt: takenAt,
      locationCapturedAt: capture.capturedAt,
      locationLines: capture.location?.lines ?? [],
      title: "Pharmacy validation live evidence",
    });
    ctx.font = `${fontSize}px Arial, Helvetica, sans-serif`;
    // Wrapped, never truncated: a long Egyptian street address is exactly the caption most worth
    // reading, and it is the one a fixed line count would have cut.
    const lines = captions.flatMap((caption) =>
      wrapWatermarkText(ctx, caption, canvas.width - pad * 2),
    );
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

  /**
   * Read the chosen licence into a data URL.
   *
   * Both the camera button and the file button land here — on a phone `capture="environment"` is
   * the only difference between them, and it is the browser, not this code, that decides whether to
   * open the camera or the gallery. Validated on THIS side too so the rep is told about a 20MB
   * scan before it is base64-encoded and pushed across the wire; the server checks it again
   * because a client-side check is a courtesy, never a gate.
   */
  function readLicenseFile(file: File | null | undefined) {
    setError(null);
    if (!file) return;
    if (!isPharmacyLicenseContentType(file.type)) {
      setError("The pharmacy licence must be a JPEG, a PNG, or a PDF.");
      return;
    }
    if (file.size > PHARMACY_LICENSE_MAX_BYTES) {
      setError("The pharmacy licence file is too large. Attach a file under 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read. Try attaching it again.");
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        setError("That file could not be read. Try attaching it again.");
        return;
      }
      setLicense({ dataUrl, fileName: file.name || "pharmacy-licence", isPdf: file.type === "application/pdf" });
      setMessage("Pharmacy licence attached.");
    };
    reader.readAsDataURL(file);
  }

  function clearLicense() {
    setLicense(null);
    // The inputs are reset so re-choosing the SAME file fires `change` again — without this,
    // removing a licence and picking it back leaves the control silently dead.
    if (licenseCameraRef.current) licenseCameraRef.current.value = "";
    if (licenseFileRef.current) licenseFileRef.current.value = "";
  }

  async function submit() {
    setError(null);
    if (!photo) return setError("Take the storefront photo.");
    // Leg 1 of the venue rule, said here as well as on the server so the rep learns it while still
    // standing in front of the shop rather than after a round trip. Same sentence both ends.
    if (capture.latitude == null || capture.longitude == null) return setError(VENUE_LOCATION_REQUIRED_MESSAGE);
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
          licenseDataUrl: license?.dataUrl ?? null,
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
      clearLicense();
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
    <section className="border border-phx-line bg-white">
      <header className="border-b border-phx-line bg-slate-900 px-4 py-2.5">
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
            <div className="mt-2 space-y-0.5 text-[11px] font-semibold text-emerald-700">
              {(capture.location?.lines ?? []).map((line, index) => (
                <p key={`${index}-${line}`}>{line}</p>
              ))}
            </div>
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

        {/* The pharmacy licence (رخصة الصيدلية). Always offered, never required — a rep who has it
            can settle the identity question on the spot instead of waiting for the desk to ask.
            Highlighted only when it is the proof this venue is genuinely short of: no distributor
            code anywhere. A nursery is skipped entirely — it has no distributor account by its
            nature and no pharmacy trade licence to produce. */}
        <div className={`border p-3 ${licenseFillsTheGap && !license ? "border-amber-300 bg-amber-50" : "border-[#eef1f3]"}`}>
          <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">
            Pharmacy licence · رخصة الصيدلية {licenseFillsTheGap ? "" : "(optional)"}
          </p>
          {licenseNote ? (
            <p className="mt-1 text-[12px] font-semibold text-amber-900" dir="auto">{licenseNote}</p>
          ) : (
            <p className="mt-1 text-[12px] font-medium text-slate-500">
              Attach it if you have it — the reviewer checks the trade name on the licence against the
              name on the shop sign.
            </p>
          )}
          <input
            accept={PHARMACY_LICENSE_ACCEPT_ATTRIBUTE}
            capture="environment"
            className="hidden"
            onChange={(e) => readLicenseFile(e.target.files?.[0])}
            ref={licenseCameraRef}
            type="file"
          />
          <input
            accept={PHARMACY_LICENSE_ACCEPT_ATTRIBUTE}
            className="hidden"
            onChange={(e) => readLicenseFile(e.target.files?.[0])}
            ref={licenseFileRef}
            type="file"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => licenseCameraRef.current?.click()}
              className="border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
            >
              Photograph licence
            </button>
            <button
              type="button"
              onClick={() => licenseFileRef.current?.click()}
              className="border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-bold text-slate-700 hover:bg-slate-50"
            >
              Choose file
            </button>
            <span className="text-[11px] font-medium text-slate-400">JPEG, PNG or PDF · up to 5 MB</span>
          </div>
          {license ? (
            <div className="mt-2 border border-emerald-300 bg-emerald-50 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-bold text-emerald-900" dir="auto">{license.fileName}</span>
                <button type="button" onClick={clearLicense} className="text-[11px] font-bold text-orange-600">
                  Remove
                </button>
              </div>
              {/* A PDF gets its name and nothing else — an inline preview would need a viewer, and
                  the reviewer opens it on the desk anyway. An image is shown, because a rep who
                  photographed the wrong page should find that out here rather than at the desk. */}
              {license.isPdf ? null : (
                <ZoomablePhoto
                  alt="Pharmacy licence"
                  caption="Pharmacy licence · رخصة الصيدلية"
                  className="mt-2 w-full max-w-md border border-emerald-200"
                  src={license.dataUrl}
                />
              )}
            </div>
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
