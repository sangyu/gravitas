// API layer: Semantic Scholar (graph + citation contexts) with a resilience waterfall:
// Europe PMC (publisher-elided reference lists) and OpenCitations COCI + Crossref
// (graph-only degraded mode when S2 is rate-limited).

const S2 = "https://api.semanticscholar.org/graph/v1";
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const COCI = "https://opencitations.net/index/coci/api/v1";
const CR = "https://api.crossref.org/works";
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
// Crossref asks apps to identify themselves for the polite pool — replace with your
// own contact email if you self-host.
const CR_MAILTO = "gravitas-app@users.noreply.example";
// NCBI E-utilities policy: identify the tool and a contact email on every
// request, and stay under 3 req/s without an API key. Replace this placeholder
// with a real address before publishing.
const NCBI_TOOL = "gravitas";
const NCBI_EMAIL = "gravitas-app@users.noreply.example";

export type StatusFn = (msg: string) => void;

export function getApiKey(): string {
  return localStorage.getItem("s2_api_key") || "";
}
export function setApiKey(k: string) {
  if (k) localStorage.setItem("s2_api_key", k);
  else localStorage.removeItem("s2_api_key");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- resilience machinery: cache, coalescing, S2 queue + circuit breaker ----
// Policy (per S2 guidance): a 429 must REDUCE traffic, not multiply it.
// S2 gets: concurrency 1, one patient retry honoring Retry-After, then the
// circuit opens for 90s and the app degrades instead of retry-storming.

let s2CircuitOpenUntil = 0;
export function s2CircuitOpen(): boolean {
  return Date.now() < s2CircuitOpenUntil;
}
export function s2CircuitRetryAt(): Date {
  return new Date(s2CircuitOpenUntil);
}

let s2Queue: Promise<any> = Promise.resolve();
function enqueueS2<T>(fn: () => Promise<T>): Promise<T> {
  const minInterval = getApiKey() ? 1100 : 2500;
  const run = s2Queue.then(async () => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      const dt = Date.now() - t0;
      if (dt < minInterval) await sleep(minInterval - dt);
    }
  });
  s2Queue = run.catch(() => {});
  return run;
}

const CACHE_TTL: [RegExp, number][] = [
  [/api\.semanticscholar\.org.*(citations|references)/, 7 * 864e5],  // graph edges: 7d
  [/api\.semanticscholar\.org/, 30 * 864e5],                          // paper metadata: 30d
  [/opencitations\.net/, 7 * 864e5],
  [/api\.crossref\.org/, 30 * 864e5],
  [/europepmc/, 7 * 864e5],
  [/eutils\.ncbi\.nlm\.nih\.gov/, 30 * 864e5],                        // PMC full texts: 30d
];
const NEG_TTL = 6 * 36e5; // negative "not found": 6h

function ttlFor(url: string): number {
  for (const [re, t] of CACHE_TTL) if (re.test(url)) return t;
  return 0;
}
function cacheGet(url: string): any {
  try {
    const raw = localStorage.getItem("cg:" + url);
    if (!raw) return undefined;
    const { t, ttl, v } = JSON.parse(raw);
    if (Date.now() - t > ttl) {
      localStorage.removeItem("cg:" + url);
      return undefined;
    }
    return v;
  } catch {
    return undefined;
  }
}
function cacheSet(url: string, v: any): void {
  const ttl = ttlFor(url);
  if (!ttl) return;
  try {
    localStorage.setItem("cg:" + url, JSON.stringify({ t: Date.now(), ttl: v === null ? NEG_TTL : ttl, v }));
  } catch {
    // storage full: evict oldest half of our keys, retry once
    try {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("cg:"));
      const aged = keys
        .map((k) => [k, JSON.parse(localStorage.getItem(k) || "{}").t || 0] as [string, number])
        .sort((a, b) => a[1] - b[1]);
      aged.slice(0, Math.ceil(aged.length / 2)).forEach(([k]) => localStorage.removeItem(k));
      localStorage.setItem("cg:" + url, JSON.stringify({ t: Date.now(), ttl, v }));
    } catch { /* give up silently */ }
  }
}

const inflight = new Map<string, Promise<any>>();

async function fetchJson(url: string, onStatus?: StatusFn, _retries?: number): Promise<any> {
  const cached = cacheGet(url);
  if (cached !== undefined) return cached;
  const pending = inflight.get(url);
  if (pending) return pending; // request coalescing
  const isS2 = url.startsWith(S2);
  const work = () => doFetch(url, onStatus).then((v) => { cacheSet(url, v); return v; });
  const p = (isS2 ? enqueueS2(work) : work()).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

async function doFetch(url: string, onStatus?: StatusFn): Promise<any> {
  const isS2 = url.startsWith(S2);
  if (isS2 && s2CircuitOpen()) throw new Error("CIRCUIT_OPEN");
  const headers: Record<string, string> = {};
  const key = getApiKey();
  if (isS2 && key) headers["x-api-key"] = key;
  const maxAttempts = isS2 ? 2 : 3;
  let lastWas429 = false;
  for (let i = 0; i < maxAttempts; i++) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch {
      lastWas429 = false;
      onStatus?.(`network hiccup — retrying (${i + 1}/${maxAttempts})…`);
      await sleep(1000 * (i + 1));
      continue;
    }
    if (res.status === 429) {
      lastWas429 = true;
      if (isS2) {
        if (i === 0) {
          const ra = parseInt(res.headers.get("retry-after") || "", 10);
          const wait = Number.isFinite(ra) && ra > 0
            ? Math.min(ra, 20) * 1000
            : 8000 + Math.random() * 4000;
          onStatus?.(`rate limited — one patient retry in ${Math.round(wait / 1000)}s…`);
          await sleep(wait);
          continue;
        }
        s2CircuitOpenUntil = Date.now() + 90_000;
        throw new Error("RATE_LIMITED");
      }
      onStatus?.("rate limited — backing off…");
      await sleep(3000 * (i + 1));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return res.json();
  }
  throw new Error(lastWas429 ? "RATE_LIMITED" : "NETWORK_FAILED");
}

// ---------- types ----------

export interface PaperNode {
  id: string;
  title: string;
  year: number | null;
  citationCount: number;
  authors: string;
  abstract?: string | null;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  oaPdfUrl?: string | null;
  isSeed?: boolean;
  unresolved?: boolean;
}

export interface CitationEdge {
  id: string;
  source: string;
  target: string;
  contexts: string[];
  intents: string[];
  influential: boolean;
  fromElisionFallback?: boolean;
  fromPmc?: boolean; // claim sentence rescued from the citing paper's PMC full text
  claimAttempted?: boolean;
  claimFailed?: boolean;
  expanded?: boolean; // user-initiated neighborhood expansion: always displayed
  refIndex?: number | null; // cited paper's position in the citing bibliography
}

export interface SeedMeta {
  id: string;
  title: string;
  year: number | null;
  authors: string;
  referenceCount: number;
  citationCount: number;
  pmid?: string;
  doi?: string;
  pmcid?: string;
  resolvedFrom: string;
  elidedRefs?: boolean;
  tooNew?: boolean;
}

// ---------- input resolution ----------

export function parseInput(raw: string): { kind: "doi" | "pmid" | "title"; value: string } {
  const s = raw.trim();
  let m = s.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/);
  if (m) return { kind: "pmid", value: m[1] };
  m = s.match(/(?:doi\.org\/|biorxiv\.org\/content\/)(10\.\d{4,5}\/[^\s]+)/i);
  if (m) return { kind: "doi", value: stripDoi(m[1]) };
  m = s.match(/nature\.com\/articles\/((?:s\d{4}-\d{3}-\d{5}-\w|nature\d+|[a-z0-9-]+))/i);
  if (m) return { kind: "doi", value: `10.1038/${m[1]}` };
  if (/^10\.\d{4,5}\/\S+$/i.test(s)) return { kind: "doi", value: stripDoi(s) };
  m = s.match(/^pmid:?\s*(\d{5,9})$/i);
  if (m) return { kind: "pmid", value: m[1] };
  m = s.match(/^doi:?\s*(10\.\d{4,5}\/\S+)$/i);
  if (m) return { kind: "doi", value: stripDoi(m[1]) };
  if (/^\d{5,9}$/.test(s)) return { kind: "pmid", value: s };
  return { kind: "title", value: s };
}

function stripDoi(d: string): string {
  return d.replace(/[.,;)]+$/, "").replace(/\.pdf$/i, "").replace(/v\d+$/i, "");
}

async function pmidToDoi(pmid: string): Promise<string | null> {
  const j = await fetchJson(
    `${EPMC}/search?query=EXT_ID:${pmid}&format=json&resultType=core`
  );
  return j?.resultList?.result?.[0]?.doi || null;
}

const PAPER_FIELDS =
  "title,year,citationCount,referenceCount,abstract,externalIds,openAccessPdf,authors";

export async function resolveSeed(input: string, onStatus?: StatusFn): Promise<SeedMeta> {
  const p = parseInput(input);
  let doi: string | null = null;
  if (p.kind === "doi") doi = p.value;
  if (p.kind === "pmid") {
    onStatus?.("resolving PMID via Europe PMC…");
    doi = await pmidToDoi(p.value);
    if (!doi) throw new Error(`PMID ${p.value} has no DOI on record.`);
  }
  if (p.kind === "title") {
    onStatus?.("searching by title…");
    let hit: any = null;
    try {
      const j = await fetchJson(
        `${S2}/paper/search?query=${encodeURIComponent(p.value)}&limit=1&fields=${PAPER_FIELDS}`,
        onStatus, 3
      );
      hit = j?.data?.[0];
    } catch {
      hit = null;
    }
    if (hit) return seedFromS2(hit, `title search: "${p.value}"`);
    onStatus?.("Semantic Scholar unavailable — searching Crossref…");
    const cr = await fetchJson(
      `${CR}?query.bibliographic=${encodeURIComponent(p.value)}&rows=1&mailto=${CR_MAILTO}`
    );
    const w = cr?.message?.items?.[0];
    if (!w?.DOI) throw new Error(`No paper found for "${p.value}". Try a DOI.`);
    const meta = await crossrefMeta(w.DOI);
    if (!meta) throw new Error(`No paper found for "${p.value}". Try a DOI.`);
    return {
      id: `doi:${meta.doi}`,
      title: meta.title,
      year: meta.year,
      authors: meta.authors,
      referenceCount: meta.referenceCount,
      citationCount: meta.citationCount,
      doi: meta.doi,
      resolvedFrom: `Crossref search: "${p.value}" (Semantic Scholar unavailable)`,
    };
  }
  onStatus?.("resolving DOI…");
  let j: any = null;
  try {
    j = await fetchJson(`${S2}/paper/DOI:${doi!}?fields=${PAPER_FIELDS}`, onStatus, 3);
  } catch {
    j = null; // degraded mode: resolve via Crossref instead
  }
  if (j) return seedFromS2(j, `DOI: ${doi}`);

  onStatus?.("Semantic Scholar unavailable — resolving via Crossref…");
  const cr = await crossrefMeta(doi!);
  if (!cr) throw new Error(`DOI ${doi} not found.`);
  return {
    id: `doi:${cr.doi}`,
    title: cr.title,
    year: cr.year,
    authors: cr.authors,
    referenceCount: cr.referenceCount,
    citationCount: cr.citationCount,
    doi: cr.doi,
    resolvedFrom: `DOI: ${doi} (via Crossref — Semantic Scholar rate-limited)`,
  };
}

function seedFromS2(j: any, resolvedFrom: string): SeedMeta {
  return {
    id: j.paperId,
    title: j.title || "Untitled",
    year: j.year ?? null,
    authors: (j.authors || []).map((a: any) => a.name).slice(0, 6).join(", "),
    referenceCount: j.referenceCount ?? 0,
    citationCount: j.citationCount ?? 0,
    pmid: j.externalIds?.PubMed,
    doi: j.externalIds?.DOI,
    pmcid: j.externalIds?.PubMedCentral ? String(j.externalIds.PubMedCentral) : undefined,
    resolvedFrom,
    tooNew: (j.referenceCount ?? 0) === 0 && (j.citationCount ?? 0) === 0,
  };
}

// ---------- Crossref / COCI helpers (degraded mode) ----------

interface CRMeta {
  doi: string; title: string; year: number | null;
  authors: string; citationCount: number; referenceCount: number;
}

async function crossrefMeta(doi: string): Promise<CRMeta | null> {
  try {
    const j = await fetchJson(`${CR}/${encodeURIComponent(doi)}?mailto=${CR_MAILTO}`);
    const w = j?.message;
    if (!w) return null;
    return {
      doi: w.DOI,
      title: (w.title || ["Untitled"])[0],
      year: w.issued?.["date-parts"]?.[0]?.[0] ?? null,
      authors: (w.author || []).map((a: any) => `${a.given?.[0] || ""}. ${a.family || ""}`.trim())
        .slice(0, 6).join(", "),
      citationCount: w["is-referenced-by-count"] ?? 0,
      referenceCount: w["reference-count"] ?? 0,
    };
  } catch {
    return null;
  }
}

async function crossrefBatch(dois: string[], onStatus?: StatusFn): Promise<Map<string, CRMeta>> {
  const out = new Map<string, CRMeta>();
  const queue = [...dois];
  while (queue.length) {
    const chunk = queue.splice(0, 6);
    onStatus?.(`fetching metadata from Crossref (${out.size}/${dois.length})…`);
    const results = await Promise.all(chunk.map((d) => crossrefMeta(d)));
    results.forEach((m) => { if (m) out.set(m.doi.toLowerCase(), m); });
  }
  return out;
}

async function cociEdges(doi: string, direction: "citations" | "references"): Promise<string[]> {
  const j = await fetchJson(`${COCI}/${direction}/${encodeURIComponent(doi)}`);
  if (!Array.isArray(j)) return [];
  return j
    .map((e: any) => (direction === "citations" ? e.citing : e.cited))
    .filter(Boolean)
    .map((d: string) => d.toLowerCase());
}

// ---------- edge fetching ----------

const EDGE_FIELDS =
  "contexts,intents,isInfluential,title,year,citationCount,abstract,externalIds,openAccessPdf,authors";

function cleanContext(raw: string): string | null {
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/Page \d+ of \d+/gi, "").replace(/\s+([.,;:)])/g, "$1").trim();
  if (t.length < 25) return null; // strip header junk, keep short real claims
  return t;
}

export interface FetchWindow {
  citeOffset: number; citeLimit: number;
  refOffset: number; refLimit: number;
}

export interface Ids {
  pmid?: string;
  doi?: string;
  useEpmcRefs?: boolean; // elision previously detected: serve refs from Europe PMC
}

export interface FetchResult {
  nodes: PaperNode[];
  edges: CitationEdge[];
  elidedRefs: boolean;
  degraded: boolean;
  citesReturned: number;
  refsReturned: number;
  citesAvail: number; // total actually available, -1 = unknown (use seed's citationCount)
  refsAvail: number;
}

function s2Node(p: any): PaperNode | null {
  if (!p || !p.paperId) return null;
  return {
    id: p.paperId,
    title: p.title || "Untitled",
    year: p.year ?? null,
    citationCount: p.citationCount ?? 0,
    authors: (p.authors || []).map((a: any) => a.name).slice(0, 3).join(", "),
    abstract: p.abstract,
    doi: p.externalIds?.DOI,
    pmid: p.externalIds?.PubMed,
    pmcid: p.externalIds?.PubMedCentral ? String(p.externalIds.PubMedCentral) : undefined,
    oaPdfUrl: p.openAccessPdf?.url || null,
    url: p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : undefined,
  };
}

export async function fetchNeighborhood(
  paperId: string,
  ids: Ids,
  w: FetchWindow,
  onStatus?: StatusFn
): Promise<FetchResult> {
  const nodes = new Map<string, PaperNode>();
  const edges: CitationEdge[] = [];
  let elidedRefs = false;
  let degraded = false;
  let citesReturned = 0, refsReturned = 0, citesAvail = -1, refsAvail = -1;

  const add = (n: PaperNode | null) => {
    if (n && !nodes.has(n.id)) nodes.set(n.id, n);
    return n;
  };

  const s2Usable = !paperId.startsWith("doi:"); // Crossref-resolved seed: skip S2

  // ---- incoming citations ----
  if (w.citeLimit > 0) {
    if (!s2Usable) {
      degraded = true;
      await cociWindow("citations");
    } else {
      try {
        onStatus?.("fetching citing papers…");
        const j = await fetchJson(
          `${S2}/paper/${paperId}/citations?fields=${EDGE_FIELDS}&limit=${Math.min(w.citeLimit, 1000)}&offset=${w.citeOffset}`,
          onStatus
        );
        const items = (j?.data || []).filter((d: any) => d.citingPaper?.paperId);
        citesReturned = items.length;
        if (j?.next == null) citesAvail = w.citeOffset + items.length; // list exhausted
        for (const d of items) {
          const n = add(s2Node(d.citingPaper));
          if (!n) continue;
          edges.push({
            id: `${n.id}->${paperId}`, source: n.id, target: paperId,
            contexts: (d.contexts || []).map(cleanContext).filter(Boolean) as string[],
            intents: d.intents || [], influential: !!d.isInfluential,
          });
        }
      } catch {
        degraded = true;
        await cociWindow("citations");
      }
    }
  }

  // ---- outgoing references ----
  if (w.refLimit > 0) {
    if (!s2Usable) {
      degraded = true;
      await cociWindow("references");
    } else if (ids.useEpmcRefs) {
      await epmcWindow();
      elidedRefs = true;
    } else {
      try {
        onStatus?.("fetching references…");
        const j = await fetchJson(
          `${S2}/paper/${paperId}/references?fields=${EDGE_FIELDS}&limit=${Math.min(w.refLimit, 1000)}&offset=${w.refOffset}`,
          onStatus
        );
        const raw: any[] = j?.data || [];
        const items = raw.filter((d: any) => d.citedPaper?.paperId);
        if (j?.next == null) refsAvail = w.refOffset + items.length;
        if (items.length === 0 && w.refOffset === 0 && ids.pmid) {
          // Publisher elision: S2 answered but the reference list was stripped.
          onStatus?.("reference list stripped by publisher — recovering via Europe PMC…");
          elidedRefs = await epmcWindow();
          refsReturned = elidedRefs ? refsReturned : 0;
        } else {
          refsReturned = items.length;
          raw.forEach((d: any, i: number) => {
            if (!d.citedPaper?.paperId) return;
            const n = add(s2Node(d.citedPaper));
            if (!n) return;
            edges.push({
              id: `${paperId}->${n.id}`, source: paperId, target: n.id,
              contexts: (d.contexts || []).map(cleanContext).filter(Boolean) as string[],
              intents: d.intents || [], influential: !!d.isInfluential,
              // seed's own reference list: array position IS the bibliography
              // position (index on the UNFILTERED list, plus the page offset)
              refIndex: w.refOffset + i,
            });
          });
        }
      } catch {
        degraded = true;
        await cociWindow("references");
      }
    }
  }

  // Europe PMC reference window (elision fallback; full list cached, sliced here)
  async function epmcWindow(): Promise<boolean> {
    if (!ids.pmid) return false;
    const epmc = await fetchJson(
      `${EPMC}/MED/${ids.pmid}/references?format=json&pageSize=1000`
    );
    const refs = epmc?.referenceList?.reference || [];
    if (refs.length === 0) return false;
    refsAvail = refs.length;
    const slice = refs.slice(w.refOffset, w.refOffset + w.refLimit);
    refsReturned = slice.length;
    slice.forEach((r: any, i: number) => {
      const nid = `epmc:${r.id}`;
      add({
        id: nid, title: r.title || "Untitled",
        year: r.pubYear ? parseInt(r.pubYear) : null, citationCount: 0,
        authors: (r.authorString || "").split(",").slice(0, 3).join(","),
        doi: r.doi, url: r.doi ? `https://doi.org/${r.doi}` : undefined,
      });
      edges.push({
        id: `${paperId}->${nid}`, source: paperId, target: nid,
        contexts: [], intents: [], influential: false, fromElisionFallback: true,
        // Europe PMC returns the reference list in bibliography order
        refIndex: w.refOffset + i,
      });
    });
    return true;
  }

  // COCI + Crossref degraded window (no claims, graph only; lists cached, sliced here)
  async function cociWindow(direction: "citations" | "references") {
    if (!ids.doi) return;
    onStatus?.(`Semantic Scholar unavailable — using OpenCitations for ${direction}…`);
    const dois = await cociEdges(ids.doi, direction);
    if (dois.length === 0) return;
    const off = direction === "citations" ? w.citeOffset : w.refOffset;
    const lim = direction === "citations" ? w.citeLimit : w.refLimit;
    const slice = dois.slice(off, off + lim);
    if (direction === "citations") {
      citesAvail = dois.length; citesReturned = slice.length;
    } else {
      refsAvail = dois.length; refsReturned = slice.length;
    }
    const metas = await crossrefBatch(slice, onStatus);
    for (const d of slice) {
      const m = metas.get(d);
      const nid = `doi:${d}`;
      add({
        id: nid,
        title: m?.title || d,
        year: m?.year ?? null,
        citationCount: m?.citationCount ?? 0,
        authors: m?.authors || "",
        doi: d,
        url: `https://doi.org/${d}`,
        unresolved: true,
      });
      edges.push(
        direction === "citations"
          ? { id: `${nid}->${paperId}`, source: nid, target: paperId, contexts: [], intents: [], influential: false }
          : { id: `${paperId}->${nid}`, source: paperId, target: nid, contexts: [], intents: [], influential: false }
      );
    }
  }

  return { nodes: [...nodes.values()], edges, elidedRefs, degraded, citesReturned, refsReturned, citesAvail, refsAvail };
}

// ---------- lazy per-edge claim fetching ----------

const S2_ID = /^[0-9a-f]{40}$/;

/**
 * On-demand claim for one edge: pull the citing paper's reference list from S2
 * (a single request — much gentler on the anonymous quota than upfront loads),
 * find the entry matching the cited paper, return its verbatim contexts.
 */
export async function fetchClaimForEdge(
  citing: PaperNode,
  cited: PaperNode,
  onStatus?: StatusFn
): Promise<{ contexts: string[]; intents: string[]; refIndex: number | null }> {
  const pid = S2_ID.test(citing.id) ? citing.id : citing.doi ? `DOI:${citing.doi}` : null;
  if (!pid) throw new Error("NO_ID");
  onStatus?.("fetching claim from Semantic Scholar…");
  const j = await fetchJson(
    `${S2}/paper/${pid}/references?fields=contexts,intents,externalIds,title&limit=1000`,
    onStatus, 4
  );
  const targetDoi = cited.doi?.toLowerCase();
  const titleHead = cited.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 30);
  const list = j?.data || [];
  for (let i = 0; i < list.length; i++) {
    const cp = list[i].citedPaper;
    if (!cp) continue;
    const doiHit = targetDoi && cp.externalIds?.DOI?.toLowerCase() === targetDoi;
    const titleHit =
      titleHead.length > 12 &&
      (cp.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").startsWith(titleHead);
    if (doiHit || titleHit) {
      return {
        contexts: ((list[i].contexts || []).map(cleanContext).filter(Boolean)) as string[],
        intents: list[i].intents || [],
        // position in the citing paper's bibliography — for [n]-style citations
        // this is the printed reference number minus one (heuristic, see Panels)
        refIndex: i,
      };
    }
  }
  return { contexts: [], intents: [], refIndex: null };
}

// ---------- PMC full-text claim rescue ----------
// Many paywalled papers (NIH/Wellcome-funded) deposit author manuscripts on
// PubMed Central. Europe PMC's API only serves the OA subset, but NCBI efetch
// serves manuscripts too — and it's JATS XML, where every in-text citation is
// an explicit <xref ref-type="bibr" rid="R7"> link to its <ref>: exact mapping.

// efetch bypasses the S2 queue, so give eutils its own throttle: a promise
// chain that spaces requests ~450ms apart (≈2.2 req/s, under the 3/s anon cap).
let eutilsChain: Promise<unknown> = Promise.resolve();
function eutilsThrottle(): Promise<void> {
  const wait = eutilsChain.then(
    () => new Promise<void>((r) => setTimeout(r, 450))
  );
  eutilsChain = wait;
  return wait;
}

async function fetchText(url: string): Promise<string | null> {
  const cached = cacheGet(url);
  if (cached !== undefined) return cached;
  const pending = inflight.get(url);
  if (pending) return pending;
  const work = async () => {
    if (url.includes("eutils.ncbi.nlm.nih.gov")) await eutilsThrottle();
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const t = await res.text();
      cacheSet(url, t);
      return t;
    } catch {
      return null;
    }
  };
  const p = work().finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

export interface PmcClaim {
  refIndex: number; // position in the <ref-list> — exact bibliography order
  titleHead: string;
  doi?: string;
  contexts: string[];
}

/** raw-text offset of `target`'s first text node within `root` */
function textOffsetIn(root: Element, target: Element): number {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let off = 0;
  let node = walker.nextNode();
  while (node) {
    if (target.contains(node)) return off;
    off += (node.textContent || "").length;
    node = walker.nextNode();
  }
  return off;
}

// sentence-end: punctuation + space + capital/digit, excluding common abbreviations
const SENT_END =
  /(?<!\bal)(?<!\be\.g)(?<!\bi\.e)(?<!\bFig)(?<!\bDr)(?<!\bvs)(?<!\bcf)[.!?]['"”)]?\s+(?=[A-Z0-9(“"])/g;

/** the sentence containing a bibr xref, using its exact position in the paragraph */
function enclosingSentence(p: Element, x: Element): string | null {
  const raw = p.textContent || "";
  if (!raw) return null;
  const off = textOffsetIn(p, x);
  let start = 0;
  let end = raw.length;
  SENT_END.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENT_END.exec(raw))) {
    if (m.index >= off) {
      end = m.index + m[0].length - (m[0].match(/\s+$/)?.[0].length || 0);
      break;
    }
    start = m.index + m[0].length;
  }
  return raw.slice(start, end).replace(/\s+/g, " ").trim() || null;
}

/**
 * Fetch the citing paper's PMC full text and extract the exact citing sentence
 * for every reference it cites (one fetch enriches all of that paper's edges).
 */
export async function fetchPmcClaims(citing: PaperNode): Promise<PmcClaim[] | null> {
  const pmcid = (citing.pmcid || "").replace(/^PMC/i, "");
  if (!pmcid) return null;
  const xml = await fetchText(
    `${EUTILS}?db=pmc&id=${pmcid}&rettype=xml&tool=${NCBI_TOOL}&email=${encodeURIComponent(NCBI_EMAIL)}`
  );
  if (!xml || !xml.includes("<article")) return null;
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const refs = new Map<string, PmcClaim>();
  doc.querySelectorAll("ref-list ref").forEach((r, i) => {
    const id = r.getAttribute("id");
    if (!id) return;
    const title = r.querySelector("article-title")?.textContent || "";
    const titleHead = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
    const doi = r.querySelector('pub-id[pub-id-type="doi"]')?.textContent?.trim() || undefined;
    refs.set(id, { refIndex: i, titleHead, doi, contexts: [] });
  });
  if (refs.size === 0) return null;
  doc.querySelectorAll('xref[ref-type="bibr"]').forEach((x) => {
    const rid = x.getAttribute("rid");
    if (!rid) return;
    const claim = refs.get(rid);
    if (!claim) return;
    const p = x.closest("p");
    if (!p) return;
    const sent = enclosingSentence(p, x as Element);
    const cleaned = sent ? cleanContext(sent) : null;
    if (cleaned && !claim.contexts.includes(cleaned) && claim.contexts.length < 5) {
      claim.contexts.push(cleaned);
    }
  });
  return [...refs.values()].filter((c) => c.contexts.length > 0);
}

/** match a graph node against PMC-extracted claims (DOI when present, else title head) */
export function matchPmcClaim(claims: PmcClaim[], cited: PaperNode): PmcClaim | null {
  const doi = cited.doi?.toLowerCase();
  const titleHead = cited.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
  for (const c of claims) {
    if (doi && c.doi && c.doi.toLowerCase() === doi) return c;
    if (titleHead.length > 12 && (c.titleHead.startsWith(titleHead) || titleHead.startsWith(c.titleHead))) return c;
  }
  return null;
}
