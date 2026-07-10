import { supabase } from '../db.js';

/**
 * Archive memories whose importance has dropped below the threshold.
 */
export async function runMemoryArchive(threshold = 0.2) {
  const { data, error } = await supabase
    .from('memories')
    .update({
      memory_state: 'archived',
    })
    .lt('importance', threshold)
    .eq('memory_state', 'active')
    .select('id');

  if (error) {
    throw new Error(`Archive failed: ${error.message}`);
  }

  return {
    archived: data?.length ?? 0,
  };
}
