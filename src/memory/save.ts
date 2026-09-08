import { supabase } from '../db.js';
import { getEmbedding } from '../embedding.js';
import { SaveMemorySchema } from './types.js';
import { success, failure } from './utils.js';

export async function handleSaveMemory(args: unknown) {
  try {
    const {
      content,
      metadata,
      memory_type,
      importance,
      unresolved,
    } = SaveMemorySchema.parse(args);

    const embedding = await getEmbedding(content);

    const { data, error } = await supabase
      .from('memories')
      .insert({
        content,
        embedding,
        metadata,

        memory_type: memory_type ?? "fact",
        importance: importance ?? 0.5,
        unresolved: unresolved ?? false,

        memory_state: 'active',

        access_count: 0,

        last_accessed: new Date().toISOString(),
      })
      .select('id, content, metadata, created_at')
      .single();

    if (error) {
      return failure(`Failed to save memory: ${error.message}`);
    }

    return success({
      success: true,
      message: 'Memory saved successfully',
      memory: {
        id: data.id,
        content: data.content,
        metadata: data.metadata,
        created_at: data.created_at,
      },
    });

  } catch (error: any) {
    return failure(error?.message ?? 'Unknown error');
  }
}