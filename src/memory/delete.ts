import { supabase } from '../db.js';

import { DeleteMemorySchema } from './types.js';
import { success, failure } from './utils.js';

export async function handleDeleteMemory(args: unknown) {
  try {
    const { id } = DeleteMemorySchema.parse(args);

    const { data: existing, error: checkError } = await supabase
      .from('memories')
      .select('id')
      .eq('id', id)
      .single();

    if (checkError) {
      if (checkError.code === 'PGRST116') {
        return failure(`Memory with ID '${id}' not found`);
      }
      return failure(`Failed to check memory: ${checkError.message}`);
    }

    const { error: deleteError } = await supabase
      .from('memories')
      .delete()
      .eq('id', id);

    if (deleteError) {
      return failure(`Failed to delete memory: ${deleteError.message}`);
    }

    return success({
      success: true,
      message: `Memory '${id}' deleted successfully`,
    });

  } catch (error: any) {
    return failure(error?.message ?? 'Unknown error');
  }
}
