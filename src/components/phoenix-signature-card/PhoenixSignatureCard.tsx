import { EmployeePortrait } from "./EmployeePortrait";
import { PhoenixLogo } from "./PhoenixLogo";
import { PhoenixWatermark } from "./PhoenixWatermark";
import type { PhoenixSignatureCardProps } from "./types";

export function PhoenixSignatureCard({
  name,
  title,
  photoSrc,
  logoSrc,
  className = "",
}: PhoenixSignatureCardProps) {
  const titleLabel = title.trim().toUpperCase() || "PHOENIX WORKFORCE";

  return (
    <section
      className={[
        "relative isolate w-full overflow-hidden bg-[#fbf5ed]",
        "shadow-[0_18px_54px_rgba(16,35,61,0.13)]",
        className,
      ].join(" ")}
      style={{ aspectRatio: "1000 / 405", containerType: "inline-size" }}
    >
      <div
        className="absolute inset-0 z-0"
        style={{
          background:
            "radial-gradient(circle at 16% 36%, rgba(244, 123, 32, 0.075), transparent 23%), radial-gradient(circle at 82% 27%, rgba(255,255,255,0.68), transparent 31%), linear-gradient(180deg, #fbf5ed 0%, #f8efe4 100%)",
        }}
      />

      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-[2.1%] top-[8.5%] z-0 h-[55%] w-[20%]"
        viewBox="0 0 320 360"
        fill="none"
      >
        <circle cx="286" cy="168" r="162" stroke="#f47b20" strokeOpacity="0.11" strokeWidth="2" />
        <circle cx="286" cy="168" r="136" stroke="#f47b20" strokeOpacity="0.13" strokeWidth="1.7" />
        <circle cx="286" cy="168" r="111" stroke="#f47b20" strokeDasharray="5 14" strokeOpacity="0.16" strokeWidth="2" />
        <circle cx="286" cy="168" r="86" stroke="#f47b20" strokeOpacity="0.17" strokeWidth="1.6" />
        <circle cx="286" cy="6" r="4" fill="#f47b20" fillOpacity="0.25" />
        <circle cx="124" cy="168" r="4" fill="#f47b20" fillOpacity="0.2" />
        <circle cx="165" cy="282" r="4" fill="#f47b20" fillOpacity="0.2" />
      </svg>

      <PhoenixWatermark />
      <PhoenixLogo src={logoSrc} />

      <svg
        aria-hidden="true"
        className="absolute bottom-0 left-0 z-0 h-[20.5%] w-full"
        viewBox="0 0 1875 170"
        preserveAspectRatio="none"
      >
        <path d="M0 56C440 86 1040 86 1875 8V170H0Z" fill="#0b2038" />
        <path d="M0 56C440 86 1040 86 1875 8" fill="none" stroke="#f47b20" strokeWidth="8" />
      </svg>

      <div
        className="absolute z-20 -translate-y-1/2"
        style={{
          left: "15.2%",
          top: "45.8%",
          width: "16.9%",
        }}
      >
        <EmployeePortrait src={photoSrc} alt={`${name} portrait`} name={name} />
      </div>

      <div
        aria-hidden="true"
        className="absolute z-20 w-px bg-[#f47b20]"
        style={{
          height: "50%",
          left: "35.4%",
          opacity: 0.7,
          top: "22%",
        }}
      />

      <div
        className="absolute z-20 -translate-y-1/2"
        style={{
          left: "38.2%",
          top: "45.8%",
          width: "40.5%",
        }}
      >
        <h1
          className="max-w-full whitespace-normal font-medium italic leading-[1.02] text-[#10233d] sm:whitespace-nowrap"
          style={{
            fontFamily: '"Great Vibes", "Segoe Script", cursive',
            fontSize: "clamp(1.45rem, 5.55cqw, 6.5rem)",
          }}
        >
          {name}
        </h1>

        <div className="mt-[clamp(5px,0.78cqw,12px)] flex w-[48%] min-w-[116px] items-center">
          <div className="h-px flex-1" style={{ backgroundColor: "#f47b20" }} />
          <div
            className="rounded-full"
            style={{
              backgroundColor: "#f47b20",
              height: "clamp(5px, 0.58cqw, 8px)",
              width: "clamp(5px, 0.58cqw, 8px)",
            }}
          />
          <div className="h-px w-[22%]" style={{ backgroundColor: "rgba(244, 123, 32, 0.68)" }} />
        </div>

        <p
          className="mt-[clamp(6px,1.05cqw,16px)] whitespace-nowrap font-extrabold uppercase"
          style={{
            color: "#f47b20",
            fontSize: "clamp(0.48rem, 1.12cqw, 1.16rem)",
            letterSpacing: "clamp(0.07rem, 0.22cqw, 0.26rem)",
          }}
        >
          {titleLabel}
        </p>
      </div>
    </section>
  );
}
