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
      className="relative z-20 w-full overflow-hidden border-[#f47b20] bg-white shadow-[0_14px_34px_rgba(15,35,55,0.18)]"
      style={{
        aspectRatio: "0.785 / 1",
        borderRadius: "clamp(12px, 1.28cqw, 20px)",
        borderWidth: "clamp(1px, 0.17cqw, 3px)",
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
