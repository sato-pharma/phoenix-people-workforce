"use client";

import { useRef, useEffect, useState, type RefObject } from "react";
import { EmployeePortrait } from "./EmployeePortrait";
import type { PhoenixSignatureCardProps } from "./types";

// Long full names (script font, one line, no wrap) can render wider than the card allows, so the
// name is shrunk to fit by its measured width — never cut with an ellipsis (AGENTS.md §4).
//
// Every measure decides from scratch: it puts the box back on its DEFAULT size (the CSS clamp) for
// one synchronous read, measures the name there, and sets a fitted size only when the name would
// not fit at the default. The earlier version reset to the default whenever the name looked
// comfortably narrow and never measured again, so when the script font swapped in after the first
// measure the name went back to full size, overflowed, and showed "Dr. Momen Abd…" (2026-10-20).
// It also re-measures when any font finishes loading: document.fonts.ready can resolve before the
// script font has even been requested.
function useFitNameFont(
  boxRef: RefObject<HTMLParagraphElement | null>,
  spanRef: RefObject<HTMLSpanElement | null>,
  text: string,
  defaultSize: string,
) {
  const [fontPx, setFontPx] = useState<number | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const span = spanRef.current;
    const box = boxRef.current;
    if (!span || !box) return;
    const measure = () => {
      const applied = box.style.fontSize;
      box.style.fontSize = defaultSize;
      // getBoundingClientRect, not scrollWidth/offsetWidth — those are
      // unreliable (often 0) on a plain `display: inline` element.
      const containerWidth = box.getBoundingClientRect().width;
      const naturalWidth = span.getBoundingClientRect().width;
      const defaultPx = parseFloat(getComputedStyle(box).fontSize) || 16;
      box.style.fontSize = applied;
      if (containerWidth <= 0 || naturalWidth <= 0) return;
      const fits = naturalWidth <= containerWidth;
      const nextPx = fits ? null : Math.max((containerWidth / naturalWidth) * defaultPx * 0.97, defaultPx * 0.4);
      setFontPx(nextPx);
      setWidth(fits ? naturalWidth : (naturalWidth / defaultPx) * (nextPx ?? defaultPx));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    document.fonts?.ready?.then(measure).catch(() => {});
    document.fonts?.addEventListener?.("loadingdone", measure);
    return () => {
      ro.disconnect();
      document.fonts?.removeEventListener?.("loadingdone", measure);
    };
  }, [boxRef, spanRef, text, defaultSize]);

  return { fontPx, width };
}

const MOBILE_NAME_SIZE = "clamp(20px, 6.6vw, 34px)";
const DESKTOP_NAME_SIZE = "clamp(1.1rem, 3.8cqw, 4.2rem)";

function signatureNameFor(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1];
  if (parts.length === 2) return `${parts[0]} ${last}`;
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}. ${last}`;
}

export function PhoenixSignatureCard({
  name,
  title,
  photoSrc,
  prefix,
  employeeCode,
  className = "",
}: PhoenixSignatureCardProps) {
  const titleLabel = title.trim().toUpperCase() || "PHOENIX WORKFORCE";
  const sigName = prefix ? `${prefix} ${signatureNameFor(name)}` : signatureNameFor(name);
  const nameRef = useRef<HTMLSpanElement>(null);
  const nameBoxRef = useRef<HTMLParagraphElement>(null);
  const { fontPx: nameFontPx, width: nameWidth } = useFitNameFont(
    nameBoxRef,
    nameRef,
    sigName,
    DESKTOP_NAME_SIZE,
  );
  const mobileNameRef = useRef<HTMLSpanElement>(null);
  const mobileNameBoxRef = useRef<HTMLParagraphElement>(null);
  const { fontPx: mobileNameFontPx, width: mobileNameWidth } = useFitNameFont(
    mobileNameBoxRef,
    mobileNameRef,
    sigName,
    MOBILE_NAME_SIZE,
  );

  return (
    <>
      {/* ── MOBILE BANNER (visible below sm) ── */}
      <section
        className="relative isolate w-full overflow-hidden sm:hidden"
        style={{ height: "150px", background: "#fdf8f3", boxShadow: "0 6px 24px rgba(16,35,61,0.12)" }}
        aria-label="Employee identity banner"
      >
        {/* Photo — the SAME framed portrait as desktop, resized to the banner so
            the face stays centred and fully in frame instead of being cropped by
            a fading strip. Its own container-type keeps the border and glow in
            proportion to the smaller size. */}
        <div
          style={{
            position: "absolute",
            left: "16px",
            top: "50%",
            transform: "translateY(-50%)",
            width: "94px",
            zIndex: 4,
            containerType: "inline-size",
          }}
        >
          <EmployeePortrait src={photoSrc} alt={`${name} portrait`} name={name} />
        </div>

        {/* Warm gradient overlay */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse at 75% 40%, rgba(255,255,255,0.5) 0%, transparent 60%)",
            zIndex: 1,
          }}
        />

        {/* Phoenix watermark — right bottom corner, bottom bleeds under navy ribbon */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          aria-hidden="true"
          src="/brand/identity-watermark.png"
          alt=""
          style={{
            position: "absolute",
            right: "-50px",
            bottom: "-28px",
            height: "102%",
            width: "auto",
            opacity: 1,
            zIndex: 2,
          }}
        />

        {/* Right content — name, title, code */}
        <div
          style={{
            position: "absolute",
            left: "124px",
            top: 0,
            right: 0,
            bottom: "38px",
            zIndex: 3,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            paddingLeft: "10px",
            paddingRight: "5%",
          }}
        >
          {/* Signature name */}
          <p
            ref={mobileNameBoxRef}
            style={{
              fontFamily: '"Pinyon Script", cursive',
              fontStyle: "italic",
              fontWeight: 500,
              color: "#2a3a5c",
              fontSize: mobileNameFontPx ? `${mobileNameFontPx}px` : MOBILE_NAME_SIZE,
              lineHeight: 1.1,
              margin: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            <span ref={mobileNameRef} style={{ display: "inline" }}>{sigName}</span>
          </p>

          {/* Orange decorative line — exact same width as name */}
          <div style={{ display: "flex", alignItems: "center", marginTop: 4, marginBottom: 4, width: mobileNameWidth ? `${mobileNameWidth}px` : "auto" }}>
            <div style={{ flex: 1, height: 1, background: "#f47b20" }} />
            <div style={{ width: 5, height: 5, background: "#f47b20", margin: "0 3px" }} />
            <div style={{ width: "18%", height: 1, background: "rgba(244,123,32,0.45)" }} />
          </div>

          {/* Job title */}
          <p
            style={{
              color: "#f47b20",
              fontSize: "clamp(9px, 2.6vw, 12px)",
              fontWeight: 700,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              margin: 0,
            }}
          >
            {titleLabel}
          </p>

          {/* Employee code */}
          {employeeCode && (
            <p
              style={{
                color: "#2a3a5c",
                fontSize: "clamp(10px, 2.8vw, 13px)",
                fontWeight: 600,
                opacity: 0.7,
                margin: "4px 0 0",
              }}
            >
              {employeeCode}
            </p>
          )}
        </div>

        {/* Navy wave + orange stroke — combined, matches desktop pattern */}
        <svg
          aria-hidden="true"
          style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: "38px", zIndex: 3 }}
          viewBox="0 0 390 38"
          preserveAspectRatio="none"
        >
          <path d="M0 18C100 28 260 28 390 8V38H0Z" fill="#0b1f3a" />
          <path d="M0 18C100 28 260 28 390 8" fill="none" stroke="#f47b20" strokeWidth="2.2" />
        </svg>
      </section>

      {/* ── DESKTOP CARD (hidden below sm) ── */}
    <section
      className={["relative isolate w-full overflow-hidden shadow-[0_12px_40px_rgba(16,35,61,0.13)] hidden sm:block", className].join(" ")}
      style={{ aspectRatio: "1875 / 420", containerType: "inline-size", background: "#fdf8f3" }}
    >
      {/* Subtle warm gradient overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{ background: "radial-gradient(ellipse at 70% 40%, rgba(255,255,255,0.55) 0%, transparent 60%), radial-gradient(ellipse at 10% 60%, rgba(244,123,32,0.06) 0%, transparent 40%)" }}
      />

      {/* Phoenix watermark — right, bleeds under navy wave */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        aria-hidden="true"
        src="/brand/identity-watermark.png"
        alt=""
        className="pointer-events-none absolute"
        style={{ right: "-2%", top: "-15%", height: "145%", width: "auto", opacity: 1, zIndex: 0 }}
      />

      {/* Photo — left, top-anchored so only bottom extends */}
      <div
        className="absolute z-10"
        style={{ left: "4.25%", top: "5%", width: "15.5%" }}
      >
        <EmployeePortrait src={photoSrc} alt={`${name} portrait`} name={name} />
      </div>

      {/* Vertical divider */}
      <div
        className="absolute z-10"
        style={{ left: "24%", top: "8%", bottom: "28%", width: "1px", background: "linear-gradient(180deg, transparent, #e0d0bc 20%, #e0d0bc 80%, transparent)" }}
      />

      {/* Content — name, title, signature */}
      <div
        className="absolute z-10 -translate-y-1/2 flex flex-col justify-center"
        style={{ left: "26%", top: "42%", right: "4%" }}
      >
        <p
          ref={nameBoxRef}
          className="italic font-medium text-[#2a3a5c]"
          style={{
            fontFamily: '"Pinyon Script", cursive',
            fontSize: nameFontPx ? `${nameFontPx}px` : DESKTOP_NAME_SIZE,
            lineHeight: 1.1,
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          <span ref={nameRef} style={{ display: "inline" }}>{sigName}</span>
        </p>
        {/* Decorative orange line — same width as name */}
        <div
          className="flex items-center"
          style={{ marginTop: "clamp(3px,0.55cqw,8px)", width: nameWidth ? `${nameWidth}px` : "auto" }}
        >
          <div className="flex-1 h-px" style={{ background: "#f47b20" }} />
          <div className="mx-[clamp(3px,0.3cqw,5px)]" style={{ width: "clamp(5px,0.55cqw,8px)", height: "clamp(5px,0.55cqw,8px)", background: "#f47b20" }} />
          <div className="h-px" style={{ width: "22%", background: "rgba(244,123,32,0.5)" }} />
        </div>
        {/* Title centered under name */}
        <p
          className="uppercase font-bold tracking-widest text-center"
          style={{
            color: "#f47b20",
            fontSize: "clamp(0.38rem, 1.05cqw, 1.15rem)",
            letterSpacing: "clamp(0.06rem,0.28cqw,0.36rem)",
            marginTop: "clamp(3px,0.55cqw,8px)",
            width: nameWidth ? `${nameWidth}px` : "auto",
          }}
        >
          {titleLabel}
        </p>
        {/* Employee code */}
        {employeeCode && (
          <p
            className="font-semibold text-center"
            style={{
              color: "#2a3a5c",
              fontSize: "clamp(0.35rem, 0.95cqw, 1rem)",
              opacity: 0.65,
              marginTop: "clamp(2px,0.4cqw,6px)",
              width: nameWidth ? `${nameWidth}px` : "auto",
            }}
          >
            {employeeCode}
          </p>
        )}
      </div>

      {/* Navy wave + orange stroke — bottom, above watermark */}
      <svg
        aria-hidden="true"
        className="absolute bottom-0 left-0 w-full"
        style={{ height: "28%", zIndex: 3 }}
        viewBox="0 0 1875 118"
        preserveAspectRatio="none"
      >
        <path d="M0 38C420 58 1030 58 1875 4V118H0Z" fill="#0b1f3a" />
        <path d="M0 38C420 58 1030 58 1875 4" fill="none" stroke="#f47b20" strokeWidth="9" />
      </svg>
    </section>
    </>
  );
}
