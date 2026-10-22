import { Box, Side } from "./geometry";

/**
 * Turns a canvas graph into a reading order by following the arrows.
 * Pure logic (no Obsidian/DOM) so it can be unit-tested.
 */

export interface FlowNode extends Box {
  id: string;
  type: "text" | "file" | "link" | "group";
}

export interface FlowEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  label?: string;
}

export interface FlowItem<N extends FlowNode = FlowNode> {
  node: N;
  /** Label of the arrow that led here, if any. */
  edgeLabel?: string;
  /** Set on the first emitted node of a group: the group's title. */
  groupHeading?: string;
}

const ROW_THRESHOLD = 60; // px: nodes whose tops are this close count as the same row

export function comparePosition(a: Box, b: Box): number {
  if (Math.abs(a.y - b.y) > ROW_THRESHOLD) return a.y - b.y;
  return a.x - b.x || a.y - b.y;
}

/** [source, target] taking arrowheads into account: an arrow only at the "from" end flips the edge. */
export function direction(e: FlowEdge): [string, string] {
  const toArrow = (e.toEnd ?? "arrow") === "arrow";
  const fromArrow = e.fromEnd === "arrow";
  return !toArrow && fromArrow ? [e.toNode, e.fromNode] : [e.fromNode, e.toNode];
}

function containingGroup(node: Box, groups: (FlowNode & { label?: string })[]): (FlowNode & { label?: string }) | null {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  let best: (FlowNode & { label?: string }) | null = null;
  for (const g of groups) {
    if (cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height) {
      if (!best || g.width * g.height < best.width * best.height) best = g; // smallest enclosing group
    }
  }
  return best;
}

export function orderByArrows<N extends FlowNode & { label?: string }>(
  allNodes: N[],
  edges: FlowEdge[]
): FlowItem<N>[] {
  const groups = allNodes.filter((n) => n.type === "group");
  const nodes = allNodes.filter((n) => n.type !== "group");
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const out = new Map<string, { to: string; label?: string }[]>();
  const incoming = new Map<string, string[]>();
  for (const n of nodes) {
    out.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    const [from, to] = direction(e);
    if (!byId.has(from) || !byId.has(to) || from === to) continue;
    out.get(from)!.push({ to, label: e.label });
    incoming.get(to)!.push(from);
  }
  for (const list of out.values()) {
    list.sort((a, b) => comparePosition(byId.get(a.to)!, byId.get(b.to)!));
  }

  const visited = new Set<string>();
  const result: FlowItem<N>[] = [];
  const seenGroups = new Set<string>();

  const emit = (n: N, label?: string) => {
    visited.add(n.id);
    const item: FlowItem<N> = { node: n };
    if (label) item.edgeLabel = label;
    const g = containingGroup(n, groups);
    if (g && g.label && !seenGroups.has(g.id)) {
      seenGroups.add(g.id);
      item.groupHeading = g.label;
    }
    result.push(item);
  };

  const ready = (id: string) => incoming.get(id)!.every((src) => visited.has(src) || src === id);

  const visit = (id: string, label: string | undefined, force: boolean) => {
    if (visited.has(id)) return;
    if (!force && !ready(id)) return; // wait until every predecessor has been written
    emit(byId.get(id)!, label);
    for (const edge of out.get(id)!) visit(edge.to, edge.label, false);
  };

  const sorted = [...nodes].sort(comparePosition);
  for (const n of sorted) if (incoming.get(n.id)!.length === 0) visit(n.id, undefined, false);
  // Anything left sits in a cycle (or behind one): start from the top-left-most.
  for (;;) {
    const next = sorted.find((n) => !visited.has(n.id));
    if (!next) break;
    visit(next.id, undefined, true);
  }
  return result;
}
