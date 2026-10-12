import { isPhxLive, phxLiveDataSource } from "@/lib/phx-live";

/**
 * The strip across the top of every page under phx-live (see src/lib/phx-live.ts).
 *
 * Server-rendered from the environment, so it is in the first HTML and never flashes in — and it
 * names the DATABASE, not the mode: red for production rows, grey for a copy. That is the question
 * the owner actually asks of this tab ("is this data real?"), and the strip is where it is answered.
 */
export function PhxLiveBanner() {
  if (!isPhxLive()) return null;
  const source = phxLiveDataSource();
  const tone =
    source.kind === "production" ? "bg-red-700 text-white" : "bg-neutral-700 text-white";
  return (
    <div
      role="status"
      data-phx-live-banner={source.kind}
      className={`sticky top-0 z-[1000] w-full rounded-none px-4 py-1 text-center text-xs font-semibold ${tone}`}
    >
      {source.label}
    </div>
  );
}
