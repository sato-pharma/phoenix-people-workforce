import Image from "next/image";

type PhoenixLogoProps = {
  src: string;
};

export function PhoenixLogo({ src }: PhoenixLogoProps) {
  return (
    <div
      className="absolute z-30 flex items-center"
      style={{
        right: "4.5%",
        top: "7.2%",
        gap: "clamp(8px, 0.95cqw, 14px)",
      }}
    >
      <div
        className="relative shrink-0"
        style={{
          height: "clamp(38px, 6.15cqw, 82px)",
          width: "clamp(38px, 6.15cqw, 82px)",
        }}
      >
        <Image
          src={src}
          alt="Phoenix Workforce logo"
          fill
          priority
          className="object-contain"
          sizes="66px"
        />
      </div>

      <div className="hidden leading-none sm:block">
        <div
          className="font-black text-[clamp(16px,2.35cqw,33px)] tracking-[0.16em]"
          style={{ color: "#10233d" }}
        >
          PHOENIX
        </div>
        <div
          className="mt-[clamp(4px,0.42cqw,6px)] text-[clamp(7px,0.98cqw,13px)] font-extrabold tracking-[0.36em]"
          style={{ color: "#f47b20" }}
        >
          WORKFORCE
        </div>
      </div>
    </div>
  );
}
