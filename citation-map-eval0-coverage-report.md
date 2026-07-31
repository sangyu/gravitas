# Eval 0: Citation-Map Feasibility — Coverage Report

**Date:** 2026-07-30 · **Status:** GO (with two architecture changes) · **Corpus:** 10 user-nominated seed papers

## Verdict

Build it. On a realistic, user-adversarial corpus:

| Gate | Criterion | Measured | Result |
|---|---|---|---|
| Claim coverage, bio slice | ≥ 50% | 49% tier-1 verbatim; **98%** with OA-PDF rescue tier | **PASS** (tier-1 alone just misses; waterfall clears it) |
| Claim coverage, overall | ≥ 30% | 49% tier-1 | **PASS** |
| Map latency | ≤ 3 s | **1.3 s** end-to-end (3 API calls, 50 edges) | **PASS** |
| Graph navigability | ≤ ~50 nodes after pruning | 7–116 refs + 0–100 citers per seed; pruning essential but sufficient | **PASS** |

## Corpus & graph density

| Seed | Year | Refs | Citers | Notes |
|---|---|---|---|---|
| Kalium channelrhodopsins (Nat Comms) | 2024 | 116 | 13 | Dense refs, young citing front |
| Dorsal Raphe serotonin / intertemporal choice | 2017 | 40 | 37 | Medium |
| BLA antagonistic neurons | 2016 | 48 | 393 | Dense citers |
| Noradrenergic LC-frontal pathways (PNAS) | 2020 | 77 | 82 | **Publisher-elided refs in S2** |
| bioRxiv: mScarlet3 two-photon | 2026 | 21 | 0 | Preprint, refs parsed fine |
| bioRxiv: Estimation graphics multi-group | 2026 | 62 | 0 | Preprint, refs parsed fine |
| bioRxiv: Phenovectors Drosophila 5HT | 2026 | 0 | 0 | **Too new — S2 hasn't parsed refs** |
| bioRxiv: MBON octopamine | 2026 | 0 | 0 | **Too new — S2 hasn't parsed refs** |
| Engram optogenetics (Nature) | 2012 | 38 | 1580 | Dense citers, old |
| Moving beyond P values (DABEST) | 2019 | 7 | 1472 | Tiny ref list, huge citing front |

Density verdict: degree-1 + top-25 pruning keeps every seed navigable (max 225 raw edges; ≤50 after pruning). Degree-2 auto-expansion confirmed a hairball risk — lazy expand only.

## Claim coverage (the core metric)

708 edges sampled across both directions:

| Seed | Edges | Verbatim context (tier 1) | OA-PDF rescuable (tier 3) |
|---|---|---|---|
| natcomms_47203 | 113 | 65% | +35% |
| pmid_28988863 | 37 | 32% | +68% |
| pmid_27749826 | 148 | 40% | +59% |
| pmid_33139568 | 82 | 49% | +51% |
| biorxiv_718060 | 21 | 76% | +10% |
| biorxiv_701654 | 62 | 76% | +13% |
| nature11028 | 138 | 37% | +60% |
| pmid_31217592 | 107 | 44% | +56% |
| **TOTAL** | **708** | **49%** | **→ 98% cumulative** |

Only **2% of edges are truly dark** (no S2 context, no OA PDF).

## New adversarial findings (these change the architecture)

1. **Publisher elision is a bigger threat than paywalls.** PNAS (and likely others) contractually strips *reference lists* from Semantic Scholar — the graph edges themselves vanish, not just claims. pmid_33139568 shows 77 refs in metadata, 0 retrievable. **Mitigation verified:** Europe PMC returned all 70 references for the same paper, and 38/44/9 for the other elision-affected seeds. → Graph backbone must be multi-source (OpenAlex primary + Europe PMC for bio), not S2 alone.

2. **OpenAlex anonymous access is dead.** As of 2026 it's a metered credit system; anonymous shared budget was exhausted (HTTP 429 with `$0 remaining`). Free per-user API keys still exist → the app needs a key-entry settings pane or a thin proxy. This was the plan already; now it's confirmed mandatory, not optional.

3. **PMC full text is OA-gated.** NIH-funded papers are *in* PMC (PMCID exists, reference lists available) but `fullTextXML` 404s unless the paper is in the OA subset. Tier-2 DIY sentence extraction only covers genuinely OA papers — but that's fine, because those are exactly the papers S2 has usually already parsed.

4. **Fresh-preprint lag.** Two 2026 bioRxiv preprints (< 4 weeks old) show 0 parsed references in S2. Expect a dead map for very recent preprints; the app should detect this and say "too new, try the published version or wait," not render an empty universe.

5. **Context noise is real.** Sampled claims included PDF-extraction junk (`"Multi-group estimation – Page 12 of 19"` bleeding into a sentence) and many background-mention citations with no intent label. Cleaning filters needed; showing intent labels will be sparse.

## Confirmed design decisions

- **Verbatim-only claims.** Every sampled context was an exact source substring. Enforce by construction (string slicing, never LLM paraphrase).
- **Waterfall holds:** S2 contexts (49%) → PMC-OA XML extraction → OA-PDF/preprint parse (cumulative 98%) → honest "paywalled" card with citing-paper abstract (2%).
- **Latency is a non-issue** for degree-1: 1.3 s cold, and all responses are immutable → cacheable forever.
- **S2 rate limits (no key) are tight** — hit 429s during a 30-request harness run. Free key required for real usage; still no backend needed.

## Golden corpus → test fixtures

These 10 seeds + measured expectations become the permanent regression suite:
- Resolver fixtures: PMID/DOI/bioRxiv-DOI inputs, preprint-version pairs (v1/v2 in corpus).
- Graph fixtures: expected ref/citer counts above (± drift tolerance, since citation counts grow).
- Elision fixture: pmid_33139568 must always resolve refs via Europe PMC fallback — a canary for multi-source graph logic.
- Coverage fixture: tier-1 claim rate for the corpus must stay ≥ 40% (alarm if S2 changes context licensing).
- Noise fixture: claims containing `Page \d+ of \d+` must be filtered.

## Next step

Build MVP against this fixture set: static SPA, OpenAlex (user key) + Europe PMC graph, S2 context waterfall, force-directed map, degree-1 top-25. Estimated build: 1–2 weekends.
