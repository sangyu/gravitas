# Third-party notices

Gravitas is built on the following open-source packages. All are MIT-licensed
unless noted; none of the project's dependencies carry copyleft obligations.

## UI primitives

- **shadcn/ui** (MIT) — the components in `src/components/ui/` (badge, button,
  input, popover, slider) are adapted from the shadcn/ui library.
  https://ui.shadcn.com — Copyright (c) 2023 shadcn
- **Radix UI** (MIT) — underlying primitives (`@radix-ui/react-popover`,
  `@radix-ui/react-slider`, `@radix-ui/react-slot`).
  https://www.radix-ui.com — Copyright (c) 2022 WorkOS
- **lucide-react** (ISC) — icons. https://lucide.dev
- **class-variance-authority**, **clsx**, **tailwind-merge** (MIT / Apache-2.0)
  — styling utilities used by the shadcn/ui component pattern.

## Visualization

- **react-force-graph-2d** (MIT) — canvas force-directed graph rendering.
  https://github.com/vasturiano/react-force-graph — Copyright (c) Vasco Asturiano
- **d3-force** (ISC) — physics simulation. https://d3js.org — Copyright
  (c) 2010–2021 Mike Bostock

## Framework

- **React** / **react-dom** (MIT) — Meta Platforms
- **react-router** (MIT) — Shopify
- **Vite**, **TypeScript**, **Tailwind CSS**, **ESLint** (MIT / Apache-2.0)
  — build tooling (dev dependencies only; not shipped in the bundle)

## Data sources (APIs, not code)

Citation data is retrieved at runtime from the Semantic Scholar Academic Graph
API, Europe PMC, NCBI E-utilities (PubMed Central), OpenCitations, and
Crossref. Each remains the property of its provider and is subject to its own
terms of use; no data is redistributed by this project.
