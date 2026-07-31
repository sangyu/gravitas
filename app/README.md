# Gravitas

Every citation has something to say. Drop in a paper (DOI, PubMed ID, URL, or title)
and get a gravity map of its citation neighborhood — solid edges carry the *verbatim
citing sentence* ("the claim"), dashed edges are paywalled or unindexed.

The name is a pun: *gravity* for the force-directed layout, *gravitas* for what the
map actually measures — influence.

Fully client-side: no backend, no tracking, nothing leaves your browser except
requests to public scholarly APIs.

## Data sources

| Role | Source |
|---|---|
| Citation graph + claims (primary) | Semantic Scholar Graph API |
| Reference lists stripped by publishers | Europe PMC |
| Claim rescue from full texts | PubMed Central (NCBI efetch) — incl. grant-mandated author manuscripts of paywalled papers |
| Graph when S2 is rate-limited | OpenCitations COCI + Crossref |

Claims are always shown verbatim, never paraphrased.

## Run locally

```bash
npm ci
npm run dev    # http://localhost:3000
npm run build  # static site in dist/
```

## Deploy to GitHub Pages

1. Create a new GitHub repo (public).
2. Push this project:
   ```bash
   git init && git add -A && git commit -m "Gravitas"
   git branch -M main
   git remote add origin git@github.com:<you>/<repo>.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Source → GitHub Actions**.
4. The included workflow (`.github/workflows/pages.yml`) builds and deploys on
   every push to `main`. Your site appears at `https://<you>.github.io/<repo>/`.

The build uses a relative base path (`base: './'`), so project pages work out of the box.

## Optional: Semantic Scholar API key

Anonymous requests share a global, heavily contended pool. A free key
(https://www.semanticscholar.org/product/api) gives you a dedicated quota —
paste it in the app's Settings gear. It's stored only in your browser's
localStorage, never sent anywhere except api.semanticscholar.org.

## How it differs

- **scite.ai** shows *how* a paper is cited (supporting / mentioning / contrasting
  Smart Citations) as flat lists. Gravitas shows the citing sentence **on the
  edge of a two-sided citation map**, for both citing and cited papers, free
  and client-side.
- **Colil** and **OpCitance** collect citation contexts for single papers from
  specific corpora. Gravitas maps contexts onto a graph around any seed paper
  and rescues contexts from PMC full texts when APIs don't have them.
- **Local Citation Network** (GPL-3) builds co-citation graphs for literature
  discovery; it has no in-text citation contexts at all.
- **CiteSee** augments a paper you're reading with citation-context highlights.
  Gravitas is a standalone map where every edge carries its verbatim claim.

## Design notes

- Claims are fetched lazily (one request per edge click) and cached in
  localStorage (papers 30d, edges 7d, claims 30d).
- Claim rescue cascade: Semantic Scholar contexts first; if those are missing
  and the citing paper is on PubMed Central, its full text (JATS XML) is
  fetched via NCBI efetch. Every in-text citation in JATS is an explicit
  `<xref>` link to its `<ref>`, so the citing sentence and the reference
  number are extracted exactly — and one fetch enriches every edge from that
  citing paper. Citation-number highlighting votes across an edge's contexts,
  so it does not depend on API reference-list ordering.
- S2 traffic is serialized (concurrency 1) behind a circuit breaker: one patient
  retry, then enrichment pauses for 90s rather than retry-storming a 429.
- The "papers per side" slider re-slices the local pool; dragging beyond what's
  been fetched triggers paginated window fetches (offset/limit) that are also cached.
