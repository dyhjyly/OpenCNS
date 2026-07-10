export interface CompressionGroup {
  group: string;

  memories: {
    id: string;
    content: string;
    importance: number;
    memory_state: string;
    created_at: string;
  }[];
}
