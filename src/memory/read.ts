import { supabase } from '../db.js';
import { ReadMemorySchema } from './types.js';
import { success, failure } from './utils.js';
import { touchMemory } from "./touch.js";

export async function handleReadMemory(args: unknown) {
  try {
    const { id } = ReadMemorySchema.parse(args);

    const { data, error } = await supabase
     .from('memories')
     .select('*')
     .eq('id', id)
     .single();

    if (!error && data) {
      await touchMemory(id);
   }

    if (error) {
      if (error.code === 'PGRST116') {
        return failure(`Memory with ID '${id}' not found`);
      }
      return failure(`Failed to read memory: ${error.message}`);
    }

    return success({
      success: true,
      memory: data,
    });

  } catch (error: any) {
    return failure(error?.message ?? 'Unknown error');
  }
}
