import { supabase } from '../db.js';
import { getEmbedding } from '../embedding.js';

import { SearchMemoriesSchema } from './types.js';
import { success, failure } from './utils.js';

export async function handleSearchMemories(args: unknown) {
  try {
    const { query, limit } = SearchMemoriesSchema.parse(args);

    const queryEmbedding = await getEmbedding(query);

    const { data, error } = await supabase.rpc('search_memories_reflex', {
      query_embedding: `[${queryEmbedding.join(',')}]`,
      match_limit: limit,
    });

    if (data?.length) {
      for (const item of data) {
       await supabase
        .from('memories')
        .update({
          importance: Math.max(
            0,
            (item.importance ?? 0.5) * 0.98
          ),
        })
        .eq('id', item.id);
     }
    }

    if (error) {
      return failure(`Failed to search memories: ${error.message}`);
    }


    return success({
      success: true,
      query,
      results: data || [],
      count: data?.length || 0,
    });

  } catch (error: any) {
    return failure(error?.message ?? 'Unknown error');
  }
}
