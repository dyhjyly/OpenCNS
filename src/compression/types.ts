import {
  MemoryState
} from "../memory/types.js";


export interface CompressionGroup {

  group: string;


  memories: {

    id: string;

    content: string;

    importance: number;

    memory_state: MemoryState;

    created_at: string;

  }[];

}