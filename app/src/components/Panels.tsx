import { useMemo } from "react";
import type { PaperNode, CitationEdge } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, Quote, Lock, FileText, AlertTriangle } from "lucide-react";

// ---------- citation-marker highlighting ----------

function firstSurname(authors: string): string | null {
  const first = (authors || "").split(",")[0].trim();
  if (!first) return null;
  const words = first.split(/\s+/);
  return words[words.length - 1] || null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Span = [number, number];

type NumToken = { num: number; start: number; end: number; rangeTo?: number };
type NumMarker = {
  start: number; end: number;   // full span, delimiters included
  nums: number[];               // all cited numbers (ranges expanded)
  tokens: NumToken[];           // printed tokens, absolute offsets
};

/** parse a marker body like "12, 13" or "26–29" (absStart = body's offset in the full text) */
function parseBody(body: string, absStart: number): { nums: number[]; tokens: NumToken[] } {
  const nums: number[] = [];
  const tokens: NumToken[] = [];
  const re = /(\d{1,3})(?:\s*[–-]\s*(\d{1,3}))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const a = parseInt(m[1], 10);
    const start = absStart + m.index;
    if (m[2] !== undefined) {
      const b = parseInt(m[2], 10);
      if (b >= a && b - a <= 25) for (let i = a; i <= b; i++) nums.push(i);
      else nums.push(a, b);
      tokens.push({ num: a, start, end: absStart + m.index + m[0].length, rangeTo: b });
    } else {
      nums.push(a);
      tokens.push({ num: a, start, end: start + m[1].length });
    }
  }
  return { nums, tokens };
}

/**
 * Extract citation-number markers from a context: bracketed/parenthesized groups
 * ([12,13], (12, 13)) and bare superscript dumps ("light-off 45", "activation 11,29,30").
 * Excludes decimals, percents, units, figure/table/equation numbers and 4-digit years.
 */
export function extractNumericMarkers(text: string): NumMarker[] {
  const out: NumMarker[] = [];
  let m: RegExpExecArray | null;
  const reB = /[[(](\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)[\])]/g;
  while ((m = reB.exec(text))) {
    const { nums, tokens } = parseBody(m[1], m.index + 1);
    out.push({ start: m.index, end: m.index + m[0].length, nums, tokens });
  }
  const reBare =
    /(?<![\d.])(?<![a-zA-Z]\s=\s)(?<!\bFig\.?\s)(?<!\bTable\s)(?<!\bEq\.?\s)(?:(?<=[\s(,;])|(?<=[a-zA-Z]\.))(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)(?![\d.])(?![%a-zA-Zμ°])(?=\s*(?:[.,;)\]]|\s|$))/g;
  while ((m = reBare.exec(text))) {
    const start = m.index + m[0].indexOf(m[1]);
    const { nums, tokens } = parseBody(m[1], start);
    if (nums.length === 0) continue;
    out.push({ start, end: start + m[1].length, nums, tokens });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Vote the cited paper's printed reference number from its own contexts:
 * every citing sentence contains OUR number; co-cited neighbors appear only
 * in some sentences. The number recurring across marker-bearing contexts wins.
 * Order-independent — needs no bibliography position at all.
 */
export function voteCitationNumber(contexts: string[]): number | null {
  // count one vote per marker containing n — recurrence across sentences AND
  // repeated appearance within one sentence are both evidence
  const counts = new Map<number, number>();
  let markerBearing = 0;
  for (const c of contexts) {
    const mks = extractNumericMarkers(c);
    if (mks.length > 0) markerBearing++;
    for (const mk of mks) for (const n of new Set(mk.nums)) counts.set(n, (counts.get(n) || 0) + 1);
  }
  if (markerBearing === 0) return null;
  let best: number | null = null;
  let bestN = 0;
  let tied = false;
  for (const [n, c] of counts) {
    if (c > bestN) { best = n; bestN = c; tied = false; }
    else if (c === bestN) tied = true;
  }
  if (best == null || tied || bestN < 2) return null;
  return best;
}

/** span of `num` inside the markers of one context (narrowed to the token when possible) */
function spanForNumber(markers: NumMarker[], num: number): Span[] {
  for (const mk of markers) {
    if (!mk.nums.includes(num)) continue;
    const tok = mk.tokens.find((t) => t.num === num);
    if (tok) return [[tok.start, tok.end]];
    const rangeTok = mk.tokens.find((t) => t.rangeTo != null && t.num <= num && num <= t.rangeTo);
    if (rangeTok) return [[rangeTok.start, rangeTok.end]];
    return [[mk.start, mk.end]];
  }
  return [];
}

/**
 * Find the citation marker(s) in a verbatim context that correspond to THIS edge's
 * cited paper. Waterfall, conservative — better to highlight nothing than the wrong marker:
 *  1. voted number from cross-context recurrence (numbered styles, order-independent)
 *  2. author–year style: cited paper's first-author surname near its year
 *  3. bibliography position when a trustworthy one exists (e.g. Europe PMC lists)
 *  4. only one marker in the sentence
 */
export function findClaimMarkerSpans(
  text: string,
  cited?: PaperNode,
  refIndex?: number | null,
  voted?: number | null
): Span[] {
  const markers = extractNumericMarkers(text);

  // 1. voted number
  if (voted != null) {
    const spans = spanForNumber(markers, voted);
    if (spans.length) return spans;
  }

  // 2. author–year
  if (cited?.year && cited.authors) {
    const surname = firstSurname(cited.authors);
    if (surname && surname.length > 2) {
      const re = new RegExp(`${escapeRe(surname)}(\\s+et\\s+al\\.?)?[^()]{0,60}?\\(?${cited.year}[a-z]?`, "i");
      const m = re.exec(text);
      if (m) return [[m.index, m.index + m[0].length]];
    }
  }

  // 3. bibliography-position match
  if (refIndex != null) {
    const spans = spanForNumber(markers, refIndex + 1);
    if (spans.length) return spans;
  }

  // 4. single marker in the sentence
  if (markers.length === 1) return [[markers[0].start, markers[0].end]];
  return [];
}

function HighlightedContext({
  text, cited, refIndex, voted,
}: {
  text: string; cited?: PaperNode; refIndex?: number | null; voted?: number | null;
}) {
  const spans = findClaimMarkerSpans(text, cited, refIndex, voted);
  if (spans.length === 0) return <>“{text}”</>;
  const parts: React.ReactNode[] = [];
  let pos = 0;
  spans.forEach(([s, e], i) => {
    if (s > pos) parts.push(text.slice(pos, s));
    parts.push(
      <mark key={i} className="bg-amber-200 text-amber-900 font-semibold rounded px-0.5">
        {text.slice(s, e)}
      </mark>
    );
    pos = e;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <>“{parts}”</>;
}

// ---------- edge claim panel ----------

export function ClaimPanel({
  edge,
  nodes,
  onClose,
  claimLoading,
  circuitOpen,
  circuitRetryAt,
  onRetryClaim,
}: {
  edge: CitationEdge;
  nodes: Map<string, PaperNode>;
  onClose: () => void;
  claimLoading?: boolean;
  circuitOpen?: boolean;
  circuitRetryAt?: Date;
  onRetryClaim?: () => void;
}) {
  const citing = nodes.get(edge.source);
  const cited = nodes.get(edge.target);
  const hasClaims = edge.contexts.length > 0;
  // the cited paper's printed reference number, voted from its own contexts
  const voted = useMemo(() => voteCitationNumber(edge.contexts), [edge.contexts]);

  return (
    <PanelShell title="Citation claim" onClose={onClose}>
      <div className="space-y-1 text-sm">
        <div className="text-teal-700 font-medium leading-snug">
          {citing?.title || "Unknown paper"}
        </div>
        <div className="text-xs text-stone-400">cites</div>
        <div className="text-stone-700 font-medium leading-snug">
          {cited?.title || "Unknown paper"}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {edge.influential && <Badge className="bg-amber-100 text-amber-800 border-amber-200">influential</Badge>}
        {edge.intents.map((i) => (
          <Badge key={i} variant="outline" className="text-stone-600">{i}</Badge>
        ))}
        {edge.fromElisionFallback && (
          <Badge variant="outline" className="text-sky-700 border-sky-200 bg-sky-50">
            refs via Europe PMC
          </Badge>
        )}
        {edge.fromPmc && (
          <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-50">
            via PMC full text
          </Badge>
        )}
      </div>

      {claimLoading ? (
        <div className="flex items-center gap-2 text-sm text-stone-500 py-2">
          <span className="w-4 h-4 border-2 border-teal-600 border-t-transparent rounded-full animate-spin inline-block" />
          Fetching claim from Semantic Scholar…
        </div>
      ) : hasClaims ? (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-stone-500 uppercase tracking-wide flex items-center gap-1.5">
            <Quote className="w-3 h-3" /> Verbatim citing text
          </div>
          {edge.contexts.map((c, i) => (
            <blockquote
              key={i}
              className="border-l-2 border-teal-500 pl-3 py-1 text-sm text-stone-700 leading-relaxed bg-teal-50/50 rounded-r"
            >
              <HighlightedContext text={c} cited={cited} refIndex={edge.refIndex} voted={voted} />
            </blockquote>
          ))}
          <p className="text-xs text-stone-400">
            Exact sentences from the citing paper (via {edge.fromPmc ? "the paper's PMC full text" : "Semantic Scholar"}). Never paraphrased.
          </p>
        </div>
      ) : edge.claimFailed ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
          {circuitOpen ? (
            <>
              <div className="text-sm font-medium text-amber-800">Enrichment temporarily paused</div>
              <p className="text-xs text-amber-700 leading-relaxed">
                Semantic Scholar is rate-limiting, so claim fetching is paused
                {circuitRetryAt ? ` until ${circuitRetryAt.toLocaleTimeString()}` : " for ~90 seconds"}.
                The citation map remains fully usable — claims will be retryable then.
              </p>
            </>
          ) : (
            <>
              <div className="text-sm font-medium text-amber-800">Couldn't fetch the claim right now</div>
              <p className="text-xs text-amber-700 leading-relaxed">
                The claim may well exist — one retry is a single request and often gets through.
              </p>
              {onRetryClaim && (
                <Button size="sm" variant="outline" onClick={onRetryClaim}>Retry claim</Button>
              )}
            </>
          )}
        </div>
      ) : edge.fromElisionFallback ? (
        <FallbackCard
          icon={<FileText className="w-4 h-4 text-sky-600" />}
          title="Reference recovered, claim unavailable"
          body="This reference list was stripped from Semantic Scholar by the publisher and recovered via Europe PMC metadata — which doesn't include citing sentences."
        />
      ) : citing?.oaPdfUrl ? (
        <FallbackCard
          icon={<FileText className="w-4 h-4 text-teal-600" />}
          title="Claim not indexed yet"
          body="No extracted citing sentence, but the citing paper is open access — you can read the citation in context directly."
          link={{ href: citing.oaPdfUrl, label: "Open OA full text" }}
        />
      ) : (
        <FallbackCard
          icon={<Lock className="w-4 h-4 text-stone-400" />}
          title="Claim unavailable (paywalled or unindexed)"
          body="The citing paper's full text isn't openly accessible, so the citing sentence can't be shown."
        />
      )}

      {!hasClaims && citing?.abstract && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-stone-500 uppercase tracking-wide">
            Abstract of citing paper instead
          </div>
          <p className="text-xs text-stone-600 leading-relaxed line-clamp-6">{citing.abstract}</p>
        </div>
      )}
    </PanelShell>
  );
}

// ---------- node panel ----------

export function PaperPanel({
  node,
  onClose,
  onExpand,
  expanding,
}: {
  node: PaperNode;
  onClose: () => void;
  onExpand: (n: PaperNode) => void;
  expanding: boolean;
}) {
  return (
    <PanelShell title={node.isSeed ? "Seed paper" : "Paper"} onClose={onClose}>
      <div>
        <div className="font-medium text-stone-800 leading-snug">{node.title}</div>
        <div className="text-xs text-stone-500 mt-1">
          {node.authors}{node.authors && node.year ? " · " : ""}{node.year ?? ""}
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Badge variant="outline">{node.citationCount.toLocaleString()} citations</Badge>
        {node.oaPdfUrl && <Badge className="bg-teal-50 text-teal-700 border-teal-200">open access</Badge>}
        {node.isSeed && <Badge className="bg-amber-100 text-amber-800 border-amber-200">seed</Badge>}
      </div>
      {node.abstract && (
        <p className="text-xs text-stone-600 leading-relaxed line-clamp-5">{node.abstract}</p>
      )}
      <div className="flex gap-2 flex-wrap pt-1">
        {node.url && (
          <Button size="sm" variant="outline" asChild>
            <a href={node.url} target="_blank" rel="noreferrer">
              View paper <ExternalLink className="w-3 h-3 ml-1" />
            </a>
          </Button>
        )}
        {!node.isSeed && !node.id.startsWith("epmc:") && !node.id.startsWith("doi:") && (
          <Button size="sm" variant="secondary" onClick={() => onExpand(node)} disabled={expanding}>
            {expanding ? "Expanding…" : "Expand neighborhood"}
          </Button>
        )}
      </div>
      {(node.id.startsWith("epmc:") || node.id.startsWith("doi:")) && (
        <p className="text-xs text-stone-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> Metadata-only node (fallback source) — cannot expand.
        </p>
      )}
    </PanelShell>
  );
}

// ---------- shared ----------

function PanelShell({
  title, children, onClose,
}: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="absolute top-4 right-4 w-[380px] max-w-[calc(100vw-2rem)] max-h-[calc(100%-2rem)] overflow-y-auto bg-white/95 backdrop-blur border border-stone-200 rounded-xl shadow-xl p-4 space-y-3 z-10">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-stone-400">{title}</span>
        <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg leading-none px-1">×</button>
      </div>
      {children}
    </div>
  );
}

function FallbackCard({
  icon, title, body, link,
}: { icon: React.ReactNode; title: string; body: string; link?: { href: string; label: string } }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 space-y-1.5">
      <div className="flex items-center gap-2 text-sm font-medium text-stone-700">{icon}{title}</div>
      <p className="text-xs text-stone-500 leading-relaxed">{body}</p>
      {link && (
        <a href={link.href} target="_blank" rel="noreferrer"
           className="text-xs text-teal-700 hover:underline inline-flex items-center gap-1">
          {link.label} <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}
