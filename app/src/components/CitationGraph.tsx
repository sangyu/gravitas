import { useMemo, useRef, useCallback, useEffect } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { forceCollide } from "d3-force";
import type { PaperNode, CitationEdge } from "@/lib/api";

interface Props {
  nodes: PaperNode[];
  edges: CitationEdge[];
  selectedEdgeId: string | null;
  selectedNodeId: string | null;
  onEdgeClick: (e: CitationEdge) => void;
  onNodeClick: (n: PaperNode) => void;
  onBackgroundClick: () => void;
}

// role-based contrasting pair: citing papers teal, cited papers rust.
// lightness encodes year within each hue (recent = deeper).
function yearT(year: number | null): number {
  if (!year) return 0.5;
  return Math.max(0, Math.min(1, (year - 1990) / (2026 - 1990)));
}
function citingColor(year: number | null): string {
  const t = yearT(year);
  return `hsl(174, ${Math.round(45 + 20 * t)}%, ${Math.round(66 - 26 * t)}%)`;
}
function citedColor(year: number | null): string {
  const t = yearT(year);
  return `hsl(20, ${Math.round(58 + 20 * t)}%, ${Math.round(70 - 24 * t)}%)`;
}
function neutralColor(year: number | null): string {
  const t = yearT(year);
  return `hsl(220, ${Math.round(12 + 8 * t)}%, ${Math.round(72 - 20 * t)}%)`;
}

type Role = "citing" | "cited" | null;

function computeRoles(edges: CitationEdge[], seedId?: string): Map<string, Role> {
  const roles = new Map<string, Role>();
  if (!seedId) return roles;
  for (const e of edges) {
    if (e.target === seedId) {
      if (roles.get(e.source) !== "cited") roles.set(e.source, "citing");
    } else if (e.source === seedId) {
      if (roles.get(e.target) !== "citing") roles.set(e.target, "cited");
    }
  }
  return roles;
}

function nodeRadius(n: PaperNode): number {
  return 3 + Math.log10((n.citationCount || 0) + 1) * 2.2;
}

export default function CitationGraph({
  nodes, edges, selectedEdgeId, selectedNodeId, onEdgeClick, onNodeClick, onBackgroundClick,
}: Props) {
  const fgRef = useRef<any>(null);

  const seedId = useMemo(() => nodes.find((n) => n.isSeed)?.id, [nodes]);
  const roles = useMemo(() => computeRoles(edges, seedId), [edges, seedId]);

  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })),
      links: edges.map((e) => ({ ...e })),
    }),
    [nodes, edges]
  );

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("charge")?.strength(-220);
    fg.d3Force("link")?.distance((l: any) => {
      const s = l.source as PaperNode, t = l.target as PaperNode;
      const dy = s.year && t.year ? Math.abs(s.year - t.year) : 0;
      // temporal gravity: edges stretch with log(publication-year gap)
      return 18 + nodeRadius(s) + nodeRadius(t) + 16 * Math.log(1 + dy);
    });
    fg.d3Force("collide", forceCollide((n: any) => nodeRadius(n as PaperNode) + 7));
  }, []);

  useEffect(() => {
    if (fgRef.current && nodes.length > 0) {
      const t = setTimeout(() => fgRef.current?.zoomToFit(800, 80), 1200);
      return () => clearTimeout(t);
    }
  }, [nodes.length]);

  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as PaperNode & { x: number; y: number };
      const r = nodeRadius(n) * (n.isSeed ? 1.5 : 1);
      const selected = selectedNodeId === n.id;
      const role = roles.get(n.id);

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = n.isSeed
        ? "#ffffff"
        : role === "citing"
        ? citingColor(n.year)
        : role === "cited"
        ? citedColor(n.year)
        : neutralColor(n.year);
      ctx.globalAlpha = 0.95;
      ctx.fill();
      ctx.globalAlpha = 1;

      // metadata-only node (OpenCitations/Crossref fallback): dashed ring, full color
      if (n.unresolved) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 1.2, 0, 2 * Math.PI);
        ctx.setLineDash([2.4, 2.2]);
        ctx.strokeStyle = "rgba(100,116,139,0.75)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (n.isSeed || selected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 2, 0, 2 * Math.PI);
        ctx.strokeStyle = n.isSeed ? "#292524" : "#0ea5e9";
        ctx.lineWidth = n.isSeed ? 2.2 : 1.6;
        ctx.stroke();
      }

      // label: seed & selection always; prominent papers when zoomed in
      const prominent = (n.citationCount || 0) > 300 && globalScale > 1.4;
      if (n.isSeed || selected || prominent || globalScale > 3.2) {
        const fs = Math.max(11 / globalScale, 2.6);
        ctx.font = `${n.isSeed ? "600 " : ""}${fs}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(15,23,42,0.85)";
        const label = n.title.length > 58 ? n.title.slice(0, 55) + "…" : n.title;
        ctx.fillText(label, n.x, n.y + r + fs + 1);
      }
    },
    [selectedNodeId]
  );

  return (
    <ForceGraph2D
      ref={fgRef}
      graphData={data}
      nodeId="id"
      nodeCanvasObject={paintNode}
      nodePointerAreaPaint={(node: any, color, ctx) => {
        const r = nodeRadius(node) * (node.isSeed ? 1.5 : 1) + 3;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      }}
      linkColor={(l: any) => {
        const e = l as CitationEdge;
        if (selectedEdgeId === e.id) return "#0ea5e9";
        const hasClaim = e.contexts.length > 0;
        // force-graph swaps source/target for node objects once the sim runs — normalize
        const srcId = typeof (e as any).source === "object" ? (e as any).source.id : e.source;
        const tgtId = typeof (e as any).target === "object" ? (e as any).target.id : e.target;
        // directional hues; unclaimed edges are the same hue, just faded + dashed
        if (tgtId === seedId) return `rgba(13,148,136,${hasClaim ? 0.6 : 0.22})`;
        if (srcId === seedId) return `rgba(219,88,20,${hasClaim ? 0.6 : 0.22})`;
        return `rgba(100,116,139,${hasClaim ? 0.5 : 0.22})`;
      }}
      linkWidth={(l: any) => {
        const e = l as CitationEdge;
        if (selectedEdgeId === e.id) return 4;
        return e.contexts.length > 0 ? 2.4 : 1;
      }}
      linkLineDash={(l: any) => ((l as CitationEdge).contexts.length > 0 ? null : [4, 4])}
      linkDirectionalArrowLength={5}
      linkDirectionalArrowRelPos={0.85}
      linkDirectionalArrowColor={(l: any) => {
        const e = l as CitationEdge;
        const hasClaim = e.contexts.length > 0;
        const srcId = typeof (e as any).source === "object" ? (e as any).source.id : e.source;
        const tgtId = typeof (e as any).target === "object" ? (e as any).target.id : e.target;
        if (tgtId === seedId) return `rgba(13,148,136,${hasClaim ? 0.85 : 0.4})`;
        if (srcId === seedId) return `rgba(219,88,20,${hasClaim ? 0.85 : 0.4})`;
        return `rgba(100,116,139,${hasClaim ? 0.7 : 0.4})`;
      }}
      onLinkClick={(l: any) => onEdgeClick(l as CitationEdge)}
      onNodeClick={(n: any) => onNodeClick(n as PaperNode)}
      onBackgroundClick={onBackgroundClick}
      linkHoverPrecision={8}
      cooldownTicks={nodes.length > 400 ? 60 : 160}
      warmupTicks={nodes.length > 400 ? 60 : 0}
      d3VelocityDecay={0.28}
      enableNodeDrag
      backgroundColor="#fafaf9"
    />
  );
}
