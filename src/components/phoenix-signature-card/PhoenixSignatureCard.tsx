"use client";

import { useRef, useEffect, useState } from "react";
import { EmployeePortrait } from "./EmployeePortrait";
import type { PhoenixSignatureCardProps } from "./types";

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
  className = "",
}: PhoenixSignatureCardProps) {
  const titleLabel = title.trim().toUpperCase() || "PHOENIX WORKFORCE";
  const sigName = prefix ? `${prefix} ${signatureNameFor(name)}` : signatureNameFor(name);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [nameWidth, setNameWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!nameRef.current) return;
    const measure = () => setNameWidth(nameRef.current!.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nameRef.current);
    return () => ro.disconnect();
  }, [sigName]);

  return (
    <section
      className={["relative isolate w-full overflow-hidden shadow-[0_12px_40px_rgba(16,35,61,0.13)]", className].join(" ")}
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
          className="italic font-medium text-[#2a3a5c]"
          style={{ fontFamily: '"Pinyon Script", cursive', fontSize: "clamp(1.1rem, 3.8cqw, 4.2rem)", lineHeight: 1.1 }}
        >
          <span ref={nameRef} style={{ display: "inline" }}>{sigName}</span>
        </p>
        {/* Decorative orange line — same width as name */}
        <div
          className="flex items-center"
          style={{ marginTop: "clamp(3px,0.55cqw,8px)", width: nameWidth ? `${nameWidth}px` : "auto" }}
        >
          <div className="flex-1 h-px" style={{ background: "#f47b20" }} />
          <div className="rounded-full mx-[clamp(3px,0.3cqw,5px)]" style={{ width: "clamp(5px,0.55cqw,8px)", height: "clamp(5px,0.55cqw,8px)", background: "#f47b20" }} />
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
  );
}
