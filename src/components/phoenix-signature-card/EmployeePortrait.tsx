import Image from "next/image";

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase() || "EM"
  );
}

type EmployeePortraitProps = {
  src: string | null;
  alt: string;
  name: string;
};

export function EmployeePortrait({ src, alt, name }: EmployeePortraitProps) {
  return (
    <div
      className="relative z-20 w-full overflow-hidden bg-white"
      style={{
        aspectRatio: "0.785 / 1",
        borderRadius: "clamp(10px, 1.1cqw, 18px)",
        border: "clamp(2px,0.25cqw,4px) solid transparent",
        backgroundImage: "linear-gradient(#fff,#fff), linear-gradient(145deg, #f9c06a, #f47b20 40%, #c45200 70%, #f9c06a)",
        backgroundOrigin: "border-box",
        backgroundClip: "padding-box, border-box",
        boxShadow: "0 0 0 clamp(2px,0.28cqw,5px) rgba(244,123,32,0.18), 0 0 clamp(12px,1.8cqw,26px) clamp(3px,0.6cqw,8px) rgba(244,123,32,0.4), 0 0 clamp(28px,3.5cqw,50px) clamp(5px,0.9cqw,13px) rgba(255,150,40,0.2), 0 12px 30px rgba(15,35,55,0.2)",
      }}
    >
      <div
        className="absolute overflow-hidden bg-[#f8efe5]"
        style={{
          inset: "clamp(5px, 0.5cqw, 7px)",
          borderRadius: "clamp(8px, 0.88cqw, 15px)",
        }}
      >
        {src ? (
          <Image
            src={src}
            alt={alt}
            fill
            priority
            unoptimized
            className="object-cover object-top"
            style={{ objectPosition: "center top" }}
            sizes="(max-width: 640px) 30vw, (max-width: 1024px) 160px, 240px"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[#fff6eb] text-[clamp(2rem,6cqw,4.8rem)] font-black text-[#f47b20]">
            {initialsFor(name)}
          </div>
        )}
      </div>
    </div>
  );
}
