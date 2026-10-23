# Preserved component styles

tailwind.css is the unmodified stylesheet from the MIT-licensed shadcn 4.16.1
npm package. RepBook imports this stylesheet only; its component source already
lives in this repository and does not need the shadcn CLI at build or runtime.

The stylesheet SHA-256 is
bc7d83425702955b4cb67cb14ede9d603f9d912376d57a2d81d661094d2a782a.
Source: https://registry.npmjs.org/shadcn/-/shadcn-4.16.1.tgz
License: [shadcn.LICENSE.md](shadcn.LICENSE.md).

Preserving these exact bytes retains the custom variants, utility styles and
animations while removing the unused CLI and its transitive glob tooling.

This is immutable third-party source, separate from RepBook-authored styles in src.
The byte-integrity regression test applies to this complete upstream stylesheet;
the existing authored design-token checks remain unchanged.
