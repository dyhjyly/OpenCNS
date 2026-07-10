import { supabase } from '../db.js';
import { computeDecay } from './decay.js';
import { loadGraph, saveGraph } from "../graph/index.js";

/**
 * 🧠 System-level decay runner
 * - can be triggered manually
 * - or scheduled later (cron / worker)
 */
export async function runMemoryDecay(batchSize = 50) {
  const { data, error } = await supabase
    .from('memories')
    .select('id, importance, last_accessed, access_count')
    .order('last_accessed', { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error(`Decay fetch failed: ${error.message}`);
  }

  if (!data?.length) return { processed: 0 };

  let updated = 0;

  for (const mem of data) {
    const result = computeDecay({
     importance: mem.importance ?? 0.5,
     last_accessed: mem.last_accessed ?? new Date().toISOString(),
     access_count: mem.access_count ?? 0,
     }); 

    await supabase
      .from('memories')
      .update({
        importance: result.importance,
      })
      .eq('id', mem.id);

    updated++;
  }


const graph = loadGraph();

for (const edge of graph.edges) {
  if (typeof edge.weight !== "number") {
    edge.weight = 1;
  } else {
    edge.weight -= 1; // 🔻衰减
  }
}

// 删除弱连接
graph.edges = graph.edges.filter((e: any) => e.weight > 0);

saveGraph(graph);

  return {
    processed: updated,
  };
}
