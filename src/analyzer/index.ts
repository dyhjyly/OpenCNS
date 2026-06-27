import { callAnalyzer } from './provider.js';
import { parseAnalysis } from './parser.js';

export async function analyzeMemory(content: string) {
  const data = await callAnalyzer(content);

  return parseAnalysis(data);
}