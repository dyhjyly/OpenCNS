import { supabase } from '../db.js';
import { getEmbedding } from '../embedding.js';

import { SearchMemoriesSchema } from './types.js';
import { success, failure } from './utils.js';

import {
  touchMemory
} from "./touch.js";


export async function handleSearchMemories(args: unknown) {
  try {

    const {
      query,
      limit
    } =
    SearchMemoriesSchema.parse(args);



    const queryEmbedding =
      await getEmbedding(query);



    const {
      data,
      error
    } =
    await supabase.rpc(
      'search_memories_reflex',
      {
        query_embedding:
          `[${queryEmbedding.join(',')}]`,

        match_limit:
          limit,
      }
    );



    /*
     * Memory Reinforcement
     *
     * 搜索命中即视为一次使用
     */
    if(data?.length){

      for(const item of data){

        await touchMemory(
          item.id
        );

      }

    }



    if(error){

      return failure(
        `Failed to search memories: ${error.message}`
      );

    }



    return success({

      success:true,

      query,

      results:
        data || [],

      count:
        data?.length || 0,

    });



  } catch(error:any){

    return failure(
      error?.message ?? "Unknown error"
    );

  }
}