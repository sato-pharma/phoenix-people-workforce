// `unstable_dynamicOnHover` on next/link: the prop the app router's Link reads, missing from the
// type `next/link` resolves to.
//
// WHY THIS FILE EXISTS (2026-10-01, "slow to transfer between page and page"). `next/link` re-exports
// `next/dist/client/link` — the PAGES router's Link — and its LinkProps has no
// `unstable_dynamicOnHover`. In the app router the same import is aliased at build time to
// `next/dist/client/app-dir/link`, whose own props DO declare it and whose code reads it: on
// mouseenter or touchstart it upgrades the link's prefetch to a full one, provided
// `experimental.dynamicOnHover` is on in next.config.ts (it is). So the prop is real at run time and
// absent only from the type the compiler is handed, which failed the typecheck on every portal link
// that uses it.
//
// This adds that one optional field to Next's own LinkProps — an AUGMENTATION merged into the
// interface, never a replacement of it. The `import` is what makes this file a module, so the block
// below augments rather than redeclares. Delete the file once `next/link`'s own type declares the prop.
import "next/link";

declare module "next/dist/client/link" {
  interface LinkProps<RouteInferType> {
    /** Upgrade to a full prefetch on hover or touch — see next/dist/client/app-dir/link. */
    unstable_dynamicOnHover?: boolean;
  }
}
