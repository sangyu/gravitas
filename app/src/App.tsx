import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import CitationGraph from "@/components/CitationGraph";
import { ClaimPanel, PaperPanel } from "@/components/Panels";
import {
  resolveSeed, fetchNeighborhood, fetchClaimForEdge, fetchPmcClaims, matchPmcClaim, getApiKey, setApiKey,
  s2CircuitOpen, s2CircuitRetryAt,
  type PaperNode, type CitationEdge, type SeedMeta,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Orbit, Settings, Loader2, Search } from "lucide-react";

// prefilled in the search bar on load — the user still has to hit "Map it"
const DEFAULT_QUERY = "10.1038/s41467-024-47203-w";

const EXAMPLES = [
  { label: "Engram optogenetics (Nature 2012)", value: "10.1038/nature11028" },
  { label: "Moving beyond P values (DABEST)", value: "10.1038/s41592-019-0470-3" },
  { label: "BLA antagonistic neurons (PMID)", value: "27749826" },
  { label: "Kalium channelrhodopsins 2024", value: DEFAULT_QUERY },
  { label: "Noradrenergic LC–frontal pathways (PNAS 2020)", value: "10.1073/pnas.2015635117" },
  { label: "Dorsal raphe & intertemporal choice (Curr Biol 2017)", value: "10.1016/j.cub.2017.09.008" },
];

const DEFAULT_N = 25;
const HARD_CAP = 1000; // per direction

export default function App() {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState("");
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [seed, setSeed] = useState<SeedMeta | null>(null);
  const [poolNodes, setPoolNodes] = useState<Map<string, PaperNode>>(new Map());
  const [poolEdges, setPoolEdges] = useState<Map<string, CitationEdge>>(new Map());
  const [totals, setTotals] = useState({ cites: 0, refs: 0 });
  const [fetched, setFetched] = useState({ cites: 0, refs: 0 });
  const [useEpmcRefs, setUseEpmcRefs] = useState(false);
  const [displayN, setDisplayN] = useState(DEFAULT_N);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [keyDraft, setKeyDraft] = useState(getApiKey());

  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;
  const totalsRef = useRef(totals);
  totalsRef.current = totals;
  const fetchingRef = useRef(false);

  const mergeResult = useCallback((result: { nodes: PaperNode[]; edges: CitationEdge[] }, expanded = false) => {
    setPoolNodes((prev) => {
      const nm = new Map(prev);
      for (const n of result.nodes) if (!nm.has(n.id)) nm.set(n.id, n);
      return nm;
    });
    setPoolEdges((prev) => {
      const em = new Map(prev);
      for (const e of result.edges) {
        if (!em.has(e.id)) em.set(e.id, expanded ? { ...e, expanded: true } : e);
      }
      return em;
    });
  }, []);

  const loadSeed = useCallback(async (input: string) => {
    setLoading(true);
    setError(null);
    setSelEdge(null);
    setSelNode(null);
    try {
      const meta = await resolveSeed(input, setStatus);
      const result = await fetchNeighborhood(
        meta.id,
        { pmid: meta.pmid, doi: meta.doi },
        { citeOffset: 0, citeLimit: 100, refOffset: 0, refLimit: 100 },
        setStatus
      );
      meta.elidedRefs = result.elidedRefs;
      setDegraded(result.degraded);
      setUseEpmcRefs(result.elidedRefs);
      const nm = new Map<string, PaperNode>();
      nm.set(meta.id, {
        id: meta.id, title: meta.title, year: meta.year, authors: meta.authors,
        citationCount: meta.citationCount, isSeed: true, pmid: meta.pmid, doi: meta.doi, pmcid: meta.pmcid,
        url: meta.doi ? `https://doi.org/${meta.doi}` : undefined,
      });
      for (const n of result.nodes) nm.set(n.id, n);
      setPoolNodes(nm);
      setPoolEdges(new Map(result.edges.map((e) => [e.id, e])));
      setTotals({
        cites: result.citesAvail >= 0 ? result.citesAvail : meta.citationCount,
        refs: result.refsAvail >= 0 ? result.refsAvail : meta.referenceCount,
      });
      setFetched({ cites: result.citesReturned, refs: result.refsReturned });
      setDisplayN(DEFAULT_N);
      setSeed(meta);
    } catch (e: any) {
      setError(
        e.message === "RATE_LIMITED"
          ? "Semantic Scholar is rate-limiting hard right now — add a free API key in Settings, or retry in a minute."
          : e.message === "NETWORK_FAILED"
          ? "Network trouble reaching the data sources — check your connection (or VPN) and retry."
          : e.message === "CIRCUIT_OPEN"
          ? `Semantic Scholar enrichment is paused until ${s2CircuitRetryAt().toLocaleTimeString()} (rate-limit circuit breaker) — the map still works; claims will be retryable then.`
          : e.message || "Something went wrong."
      );
    } finally {
      setLoading(false);
      setStatus("");
    }
  }, []);

  // fetch additional windows when the slider exceeds what's in the pool
  useEffect(() => {
    if (!seed) return;
    const needCites = Math.min(displayN, totals.cites);
    const needRefs = Math.min(displayN, totals.refs);
    if (fetched.cites >= needCites && fetched.refs >= needRefs) return;
    if (fetchingRef.current) return;

    fetchingRef.current = true;
    setLoadingMore(true);
    (async () => {
      try {
        const ids = { pmid: seed.pmid, doi: seed.doi, useEpmcRefs };
        while (fetchedRef.current.cites < Math.min(displayN, totalsRef.current.cites)) {
          const off = fetchedRef.current.cites;
          const r = await fetchNeighborhood(
            seed.id, ids,
            { citeOffset: off, citeLimit: Math.min(HARD_CAP, displayN - off + 75), refOffset: 0, refLimit: 0 },
            setStatus
          );
          mergeResult(r);
          if (r.citesReturned === 0) {
            setTotals((t) => ({ ...t, cites: off }));
            break;
          }
          setFetched((f) => ({ ...f, cites: off + r.citesReturned }));
        }
        while (fetchedRef.current.refs < Math.min(displayN, totalsRef.current.refs)) {
          const off = fetchedRef.current.refs;
          const r = await fetchNeighborhood(
            seed.id, ids,
            { citeOffset: 0, citeLimit: 0, refOffset: off, refLimit: Math.min(HARD_CAP, displayN - off + 75) },
            setStatus
          );
          mergeResult(r);
          if (r.refsReturned === 0) {
            setTotals((t) => ({ ...t, refs: off }));
            break;
          }
          setFetched((f) => ({ ...f, refs: off + r.refsReturned }));
        }
      } catch (e: any) {
        setError(e.message === "RATE_LIMITED" || e.message === "CIRCUIT_OPEN"
          ? "Rate limited while fetching more papers — what you see is what's been fetched so far."
          : e.message || "Failed to fetch more papers.");
      } finally {
        fetchingRef.current = false;
        setLoadingMore(false);
        setStatus("");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayN, seed]);

  const expand = useCallback(async (node: PaperNode) => {
    setExpanding(true);
    try {
      const result = await fetchNeighborhood(
        node.id, { pmid: node.pmid, doi: node.doi },
        { citeOffset: 0, citeLimit: 8, refOffset: 0, refLimit: 8 }, setStatus
      );
      mergeResult(result, true);
    } catch (e: any) {
      setError(e.message || "Expand failed.");
    } finally {
      setExpanding(false);
      setStatus("");
    }
  }, [mergeResult]);

  // force-graph mutates link source/target into node objects — normalize before Map lookups
  const loadClaim = useCallback(async (edge: CitationEdge) => {
    const srcId = typeof (edge as any).source === "object" ? (edge as any).source.id : edge.source;
    const tgtId = typeof (edge as any).target === "object" ? (edge as any).target.id : edge.target;
    const citing = poolNodes.get(srcId);
    const cited = poolNodes.get(tgtId);
    if (!citing || !cited) return;
    const markFailed = (eid: string) =>
      setPoolEdges((prev) => {
        const em = new Map(prev);
        const cur = em.get(eid);
        if (cur) em.set(eid, { ...cur, claimAttempted: true, claimFailed: true });
        return em;
      });
    setClaimLoading(true);
    try {
      // tier 1: Semantic Scholar contexts (useless for publisher-elided lists — skip)
      if (!edge.fromElisionFallback && !s2CircuitOpen()) {
        try {
          const r = await fetchClaimForEdge(citing, cited, setStatus);
          if (r.contexts.length > 0) {
            setPoolEdges((prev) => {
              const em = new Map(prev);
              const cur = em.get(edge.id);
              if (cur) em.set(edge.id, {
                ...cur,
                contexts: r.contexts,
                intents: r.intents.length > 0 ? r.intents : cur.intents,
                refIndex: r.refIndex ?? cur.refIndex,
                claimAttempted: true, claimFailed: false,
              });
              return em;
            });
            return;
          }
        } catch { /* fall through to PMC rescue */ }
      }
      // tier 2: the citing paper's own full text on PubMed Central
      // (grant-mandated manuscripts cover many paywalled papers; one fetch
      //  enriches every edge from this citing paper, with exact bibliography order)
      const clickedHadContexts = (poolEdges.get(edge.id)?.contexts.length ?? 0) > 0;
      if (citing.pmcid) {
        setStatus("rescuing claims from the citing paper's PMC full text…");
        const claims = await fetchPmcClaims(citing);
        if (claims && claims.length > 0) {
          let clickedRescued = false;
          setPoolEdges((prev) => {
            const em = new Map(prev);
            for (const [eid, cur] of em) {
              if (cur.source !== srcId || cur.fromPmc) continue;
              const tgt = poolNodes.get(cur.target);
              if (!tgt) continue;
              const m = matchPmcClaim(claims, tgt);
              if (!m) continue;
              em.set(eid, {
                ...cur,
                contexts: cur.contexts.length > 0 ? cur.contexts : m.contexts,
                refIndex: m.refIndex, // JATS ref-list order is exact — beats any heuristic
                claimAttempted: true, claimFailed: false,
                fromPmc: cur.contexts.length > 0 ? cur.fromPmc : true,
              });
              if (eid === edge.id) clickedRescued = true;
            }
            return em;
          });
          if (clickedRescued || clickedHadContexts) return;
        }
      }
      if (!clickedHadContexts) markFailed(edge.id);
    } finally {
      setClaimLoading(false);
      setStatus("");
    }
  }, [poolNodes]);

  const onEdgeClick = useCallback((e: CitationEdge) => {
    setSelEdge(e.id);
    setSelNode(null);
    const srcId = typeof (e as any).source === "object" ? (e as any).source.id : e.source;
    // numbered-style contexts ([n], (n), or superscript dumps like ".12,13") need the
    // bibliography position to highlight the right number
    const wantsRefIndex = e.refIndex == null && e.contexts.some(
      (c) => /[[(]\s*\d{1,3}\s*[,–\])-]/.test(c) || /\.\s?\d{1,3}\s*[,–-]\s*\d{1,3}/.test(c)
    );
    if ((e.contexts.length === 0 || wantsRefIndex) && !e.claimAttempted) {
      const citing = poolNodes.get(srcId);
      if (!citing) return;
      // elision-fallback edges: S2 has nothing, but PMC full text may
      const canTryS2 = !e.fromElisionFallback && !!(citing.doi || /^[0-9a-f]{40}$/.test(citing.id));
      if (!canTryS2 && !citing.pmcid) return;
      if (s2CircuitOpen() && !citing.pmcid) {
        setPoolEdges((prev) => {
          const em = new Map(prev);
          const cur = em.get(e.id);
          if (cur) em.set(e.id, { ...cur, claimAttempted: true, claimFailed: true });
          return em;
        });
        return;
      }
      loadClaim(e);
    }
  }, [poolNodes, loadClaim]);

  // derive the visible graph: top-N per direction from the pool + expansion extras
  const { nodeList, edgeList } = useMemo(() => {
    if (!seed) return { nodeList: [] as PaperNode[], edgeList: [] as CitationEdge[] };
    const ins: CitationEdge[] = [], outs: CitationEdge[] = [], extras: CitationEdge[] = [];
    for (const e of poolEdges.values()) {
      if (e.expanded) extras.push(e);
      else if (e.target === seed.id) ins.push(e);
      else if (e.source === seed.id) outs.push(e);
    }
    const rank = (e: CitationEdge, dir: "in" | "out") =>
      poolNodes.get(dir === "in" ? e.source : e.target)?.citationCount || 0;
    ins.sort((a, b) => rank(b, "in") - rank(a, "in"));
    outs.sort((a, b) => rank(b, "out") - rank(a, "out"));
    const vis = [...ins.slice(0, displayN), ...outs.slice(0, displayN), ...extras];
    const ids = new Set<string>([seed.id]);
    for (const e of vis) { ids.add(e.source); ids.add(e.target); }
    const nodes = [...ids].map((i) => poolNodes.get(i)!).filter(Boolean);
    return { nodeList: nodes, edgeList: vis };
  }, [poolNodes, poolEdges, seed, displayN]);

  const claimStats = useMemo(() => {
    if (edgeList.length === 0) return null;
    const withClaims = edgeList.filter((e) => e.contexts.length > 0).length;
    return { withClaims, total: edgeList.length, pct: Math.round((100 * withClaims) / edgeList.length) };
  }, [edgeList]);

  const sliderMax = Math.max(10, Math.min(HARD_CAP, Math.max(totals.cites, totals.refs)));
  const selectedEdge = selEdge ? poolEdges.get(selEdge) : null;
  const selectedNode = selNode ? poolNodes.get(selNode) : null;

  return (
    <div className="h-screen w-screen flex flex-col bg-stone-50 overflow-hidden">
      {/* top bar */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-stone-200 bg-white z-20 flex-wrap">
        <div className="flex items-center gap-2 font-semibold text-stone-800">
          <Orbit className="w-5 h-5 text-teal-600" />
          Gravitas
        </div>
        <form
          className="flex gap-2 flex-1 min-w-[280px] max-w-2xl"
          onSubmit={(e) => { e.preventDefault(); if (query.trim()) loadSeed(query); }}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="DOI, PubMed ID, paper URL, or title…"
            className="flex-1"
          />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            <span className="ml-1.5 hidden sm:inline">Map it</span>
          </Button>
        </form>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm">Examples</Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.value}
                className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-stone-100"
                onClick={() => { setQuery(ex.value); loadSeed(ex.value); }}
              >
                {ex.label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon"><Settings className="w-4 h-4" /></Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 space-y-2 p-3">
            <div className="text-sm font-medium">Semantic Scholar API key (optional)</div>
            <p className="text-xs text-stone-500">
              Avoids rate limits. Free at semanticscholar.org/product/api — stored only in your browser.
            </p>
            <div className="flex gap-2">
              <Input value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="paste key" />
              <Button size="sm" variant="secondary" onClick={() => setApiKey(keyDraft.trim())}>Save</Button>
            </div>
          </PopoverContent>
        </Popover>
      </header>

      {/* main */}
      <div className="relative flex-1">
        {nodeList.length === 0 && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8 space-y-4">
            <Orbit className="w-14 h-14 text-teal-600/60" />
            <h1 className="text-2xl font-semibold text-stone-800">Every citation has something to say.</h1>
            <p className="text-stone-500 max-w-md text-sm leading-relaxed">
              Drop in a paper and get a gravity map of its citation neighborhood.
              <span className="text-teal-700 font-medium"> Solid edges</span> have the actual citing
              sentence attached — click one to read the claim. <span className="text-stone-400 font-medium">Dashed edges</span> are paywalled or unindexed.
            </p>
          </div>
        )}

        {nodeList.length > 0 && (
          <CitationGraph
            nodes={nodeList}
            edges={edgeList}
            selectedEdgeId={selEdge}
            selectedNodeId={selNode}
            onEdgeClick={onEdgeClick}
            onNodeClick={(n) => { setSelNode(n.id); setSelEdge(null); }}
            onBackgroundClick={() => { setSelEdge(null); setSelNode(null); }}
          />
        )}

        {/* status + stats */}
        {seed && (
          <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-600 space-y-0.5 max-w-sm z-10">
            <div className="font-medium text-stone-800 truncate">{seed.title}</div>
            <div>
              {nodeList.length} papers · {edgeList.length} citation links
              {claimStats && (
                <> · <span className="text-teal-700 font-medium">{claimStats.pct}%</span> ({claimStats.withClaims}/{claimStats.total}) with verbatim claims</>
              )}
            </div>
            {seed.elidedRefs && (
              <div className="text-sky-700">Publisher stripped this paper's reference list — recovered via Europe PMC.</div>
            )}
            {degraded && (
              <div className="text-amber-700">Semantic Scholar rate-limited — graph from OpenCitations/Crossref, no claims this load. Retry later for claims.</div>
            )}
            {seed.tooNew && (
              <div className="text-amber-700">This paper looks too freshly posted to be indexed — check back later or use the published version.</div>
            )}
          </div>
        )}

        {/* display controls */}
        {seed && (
          <div className="absolute bottom-4 right-4 w-64 bg-white/90 backdrop-blur border border-stone-200 rounded-lg px-3 py-2.5 z-10 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-stone-600">
              <span className="font-medium">Papers per side</span>
              <span className="font-semibold text-teal-700">{displayN}</span>
            </div>
            <Slider
              min={10}
              max={sliderMax}
              step={5}
              value={[Math.min(displayN, sliderMax)]}
              onValueChange={([v]) => setDisplayN(v)}
            />
            <div className="text-[11px] text-stone-400">
              {Math.min(displayN, totals.cites).toLocaleString()} citing + {Math.min(displayN, totals.refs).toLocaleString()} references
              · of {totals.cites.toLocaleString()} / {totals.refs.toLocaleString()} available
            </div>
            {displayN < sliderMax && (
              <button
                className="text-[11px] text-teal-700 hover:underline"
                onClick={() => setDisplayN(sliderMax)}
              >
                Show all {sliderMax.toLocaleString()} per side (may get hairy)
              </button>
            )}
            {loadingMore && (
              <div className="text-[11px] text-stone-500 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> fetching more…
              </div>
            )}
          </div>
        )}

        {/* legend */}
        {nodeList.length > 0 && (
          <div className="absolute top-4 left-4 bg-white/90 backdrop-blur border border-stone-200 rounded-lg px-3 py-2 text-xs text-stone-500 space-y-1 z-10">
            <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-white border-2 border-stone-700 inline-block" /> seed paper</div>
            <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "hsl(174,60%,45%)" }} /> citing papers</div>
            <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "hsl(20,72%,52%)" }} /> cited papers</div>
            <div className="flex items-center gap-2"><span className="w-6 border-t-2 border-teal-600 inline-block" /> claim available</div>
            <div className="flex items-center gap-2"><span className="w-6 border-t border-dashed border-stone-400 inline-block" /> paywalled / unindexed</div>
            <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full border border-dashed border-stone-500 inline-block" /> metadata-only (fallback source)</div>
            <div className="text-stone-400 pt-0.5">size = citations · length = log(year gap) · arrows point to the cited paper</div>
          </div>
        )}

        {(loading || loadingMore) && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-white/95 border border-stone-200 text-stone-600 text-sm rounded-lg px-4 py-2 z-30 flex items-center gap-2 shadow">
            <Loader2 className="w-4 h-4 animate-spin text-teal-600" />
            {status || "loading…"}
          </div>
        )}

        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-2 z-30 max-w-lg">
            {error}
          </div>
        )}

        {selectedEdge && (
          <ClaimPanel
            edge={selectedEdge}
            nodes={poolNodes}
            onClose={() => setSelEdge(null)}
            claimLoading={claimLoading}
            circuitOpen={s2CircuitOpen()}
            circuitRetryAt={s2CircuitRetryAt()}
            onRetryClaim={() => loadClaim(selectedEdge)}
          />
        )}
        {selectedNode && (
          <PaperPanel node={selectedNode} onClose={() => setSelNode(null)} onExpand={expand} expanding={expanding} />
        )}
      </div>

      <footer className="px-4 py-1.5 text-[11px] text-stone-400 border-t border-stone-200 bg-white flex flex-wrap gap-x-1.5">
        <span>
          Data: Semantic Scholar · Europe PMC · PubMed Central full texts · OpenCitations · Crossref · claims shown verbatim, never paraphrased · nothing leaves your browser
        </span>
        <span className="ml-auto whitespace-nowrap">
          © {new Date().getFullYear()}{" "}
          <a
            href="https://xusangyu.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-500 hover:text-teal-700 hover:underline"
          >
            Sangyu Xu
          </a>
        </span>
      </footer>
    </div>
  );
}
