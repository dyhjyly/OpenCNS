export type MemoryType =
  | 'fact'
  | 'preference'
  | 'goal'
  | 'identity'
  | 'belief'
  | 'error'
  | 'understanding';

export type CognitiveSubject =
  | 'user'
  | 'assistant'
  | 'shared';

export interface AnalysisResult {
  speaker: string;

  subject: CognitiveSubject;

  memory_type: MemoryType;

  content: string;

  importance: number;

  unresolved: boolean;

  valence: number;

  arousal: number;

  keywords: string[];
}