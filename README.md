# Gravitas

**Every citation has something to say.**

Drop in a paper — DOI, PubMed ID, URL, or title — and get a gravity map of its citation
neighbourhood. Click any edge and you get the *actual sentence* the citing paper wrote about
the cited one. Verbatim, never paraphrased, never summarised by a model.

**→ [Try it live](https://sangyu.github.io/gravitas/)**

![Gravitas demo](docs/demo.gif)

*([full-quality video](docs/demo.mp4) · 43s)*

---

## Why

Citation counts tell you *that* a paper was cited. They never tell you **why**, or whether the
citing author agreed. That information exists — it's sitting in the citing paper's own prose —
it's just never surfaced next to the graph.

Gravitas puts it on the edge. Click a link between two papers and read the sentence.

The claims are extracted by string slicing, never generated. If a sentence appears in Gravitas,
it appears verbatim in the citing paper. This is enforced by construction, not by prompt.

## The map

![Citation graph](docs/graph.png)

| Encoding | Meaning |
|---|---|
| ⚪ White node, dark ring | your seed paper |
| 🟢 Teal nodes | papers **citing** the seed |
| 🟠 Orange nodes | papers the seed **cites** |
| Node size | citation count (log-scaled) |
| Edge length | log of the publication-year gap — older work drifts outward |
| **Solid edge** | a verbatim claim is available: click it |
| Dashed edge | paywalled or unindexed — no claim retrievable |
| Arrow direction | points at the *cited* paper |

Click any node to open it, or **Expand neighbourhood** to pull in its own citations — the
satellite clusters in the screenshot above.

## How the claims are found

Coverage comes from a waterfall, because no single source has everything:

1. **Semantic Scholar citation contexts** — fast, but only covers about half of all edges.
2. **PubMed Central full text** via NCBI E-utilities. This is the interesting one: many
   paywalled papers deposit NIH/Wellcome-mandated *author manuscripts* in PMC, which sit
   outside the PMC Open Access subset that other citation-context corpora are built from. The
   full text is JATS XML, where every in-text citation is an explicit
   `<xref ref-type="bibr" rid="...">` pointing at its `<ref>` — so the citing sentence and its
   bibliography number are recovered exactly, with no NLP guessing. One fetch enriches every
   edge from that paper.
3. **Honest failure** — a "paywalled" card rather than a fabricated summary.

On a 10-paper adversarial corpus this took verbatim-claim coverage from **49% → 98%** of edges,
with only 2% genuinely dark. Full numbers in
[`citation-map-eval0-coverage-report.md`](citation-map-eval0-coverage-report.md).

## Data sources

| Role | Source |
|---|---|
| Citation graph + claims (primary) | Semantic Scholar Graph API |
| Reference lists stripped by publishers | Europe PMC |
| Claim rescue from full text | PubMed Central (NCBI E-utilities) |
| Graph when Semantic Scholar is rate-limited | OpenCitations COCI + Crossref |

### Publisher elision

Some publishers — PNAS and Cell Press among them — contractually strip *reference lists* out of
Semantic Scholar. The paper reports 77 references and the API returns none: the graph edges
themselves vanish, not just the claims.

Gravitas detects this at runtime (metadata says references exist, the endpoint returns nothing)
and transparently refetches the backbone from Europe PMC, then backfills citation counts and
DOIs that Europe PMC's reference endpoint omits. The
`Noradrenergic LC–frontal pathways (PNAS 2020)` example demonstrates the recovery.

## Running locally

```bash
cd app
npm ci
npm run dev      # http://localhost:3000
npm run build    # static site in dist/
```

Fully client-side. No backend, no tracking, no build-time secrets — nothing leaves your browser
except requests to public scholarly APIs.

### Optional: Semantic Scholar API key

Anonymous requests share a heavily contended global pool. A [free
key](https://www.semanticscholar.org/product/api) gives you a dedicated quota — paste it into
the Settings gear. It lives in your browser's `localStorage` and is sent only to
`api.semanticscholar.org`.

## Design notes

- Claims are fetched lazily, one request per edge click, and cached in `localStorage`
  (papers 30d, edges 7d, claims 30d).
- Semantic Scholar traffic is serialised at concurrency 1 behind a circuit breaker: one patient
  retry honouring `Retry-After`, then enrichment pauses for 90s rather than retry-storming a
  429. A rate limit should *reduce* traffic, not multiply it.
- The "papers per side" slider re-slices a local pool; dragging past what's been fetched
  triggers paginated window fetches that are also cached.
- References are ranked by citation count before the top-N cut, so the visible map is the
  locally important literature rather than the first N in bibliography order.

## Prior art

Gravitas is not the first tool to think citation context matters, and it's worth naming the
neighbours:

- **[scite.ai](https://scite.ai)** — the commercial incumbent. 1.6B+ citation statements,
  classified supporting/contrasting/mentioning by a deep learning model. Subscription only.
- **[Colil](https://colil.dbcls.jp/portal/)** and
  **[OpCitance](https://www.nature.com/articles/s41597-023-02134-x)** — citation-context
  corpora built from the PMC Open Access subset.
- **[Local Citation Network](https://localcitationnetwork.github.io/)** — client-side,
  multi-source citation graphs. No citation contexts.

What's different here: the claims are free, verbatim by construction with no model in the loop,
and the PMC author-manuscript tier reaches paywalled papers that the OA-subset corpora above
don't cover.

## Author

Sangyu Xu — [xusangyu.com](https://xusangyu.com) · [xusangyu@gmail.com](mailto:xusangyu@gmail.com)

Issues and pull requests welcome.

## Licence

Apache 2.0 — see [LICENSE](LICENSE). Third-party components are credited in
[app/THIRD-PARTY.md](app/THIRD-PARTY.md).
