export interface AnalysisResult {
  memory_type: 'fact' | 'understanding' | 'belief';

  importance: number;

  unresolved: boolean;

  valence: number;

  arousal: number;

  keywords: string[];
}