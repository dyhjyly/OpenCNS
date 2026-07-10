import fs from "fs";
import path from "path";
import { MemoryModule } from "../memory/index.js";
import crypto from "crypto";

const GRAPH_PATH = path.resolve("data/graph.json");

type GraphNode = {
  id: string;
  topic: string;
  importance: number;
  timestamp: number;
  memory: any;
};

type GraphEdge = {
  from: string;
  to: string;
  type: string;
  weight: number;
};

type GraphState = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

/**
 * Load graph from disk
 */
export function loadGraph(): GraphState {
  try {
    if (!fs.existsSync(GRAPH_PATH)) {
      return { nodes: [], edges: [] };
    }
    return JSON.parse(fs.readFileSync(GRAPH_PATH, "utf-8"));
  } catch {
    return { nodes: [], edges: [] };
  }
}

/**
 * Save graph to disk
 */
export function saveGraph(graph: GraphState) {
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
}

/**
 * Build graph from memory
 */
function calculateEdgeWeight(
  source: GraphNode,
  target: GraphNode
): number {

  const sourceImportance =
    source.memory?.importance ?? 0.5;

  const targetImportance =
    target.memory?.importance ?? 0.5;

  const importanceScore =
    (sourceImportance + targetImportance) * 0.6;

  const frequencyScore = 0.3;

  const topicScore =
    source.topic === target.topic ? 0.1 : 0;

  return Number(
    (importanceScore + frequencyScore + topicScore).toFixed(2)
  );
}

export async function runGraph() {
  const memories = MemoryModule.getAll();

  const existing = loadGraph();

  const nodes: GraphNode[] = memories.map((memory) => {
  const id = crypto
    .createHash("md5")
    .update(memory.raw + memory.timestamp)
    .digest("hex");

  return {
    id,
    topic: memory.topic,
    importance: memory.importance,
    timestamp: memory.timestamp,
    memory,
  };
});

  const edges: GraphEdge[] = [];

  const allNodes = [
  ...existing.nodes,
  ...nodes,
];

// 新节点 vs 所有历史节点
 for (let i = 0; i < nodes.length; i++) {
   for (let j = 0; j < allNodes.length; j++) {
     if (nodes[i].id === allNodes[j].id) continue;

     if (nodes[i].topic === allNodes[j].topic) {
      edges.push({
       from: nodes[i].id,
         to: allNodes[j].id,
       type: "same-topic",
          weight: calculateEdgeWeight(
          nodes[i],
        allNodes[j]
       ),
      });
    }
  }
}

// 旧节点
const existingNodeMap = new Map(
  existing.nodes.map((n) => [n.id, n])
);

// 合并 nodes（新覆盖旧）
for (const node of nodes) {
  existingNodeMap.set(node.id, node);
}

// 合并 edges（追加 + 去重）
const mergedEdges = (existing.edges as GraphEdge[]).map((e) => ({
  ...e,
  weight: e.weight || 1,
}));

for (const edge of edges) {
  const existingEdge = mergedEdges.find(
    (e) =>
      e.from === edge.from &&
      e.to === edge.to &&
      e.type === edge.type
  );

  if (existingEdge) {
    // 👉 强化关系
    existingEdge.weight = (existingEdge.weight || 1) + 1;
  } else {
    mergedEdges.push(edge);
  }
}

const mergedNodes = Array.from(existingNodeMap.values());

const validIds = new Set(
  mergedNodes.map((n) => n.id)
);

const cleanedEdges = mergedEdges.filter(
  (edge) =>
    validIds.has(edge.from) &&
    validIds.has(edge.to)
);

const mergedGraph: GraphState = {
  nodes: mergedNodes,
  edges: cleanedEdges,
};

saveGraph(mergedGraph);

  return {
    enabled: true,
    nodes: mergedGraph.nodes.length,
    edges: mergedGraph.edges.length,
    status: "persisted",
    data: nodes,
    edgeData: edges,
    disk: GRAPH_PATH,
  };
}

/**
 * Optional export for future modules
 */
export const GraphModule = {
  run: runGraph,
  loadGraph,
  saveGraph,
};