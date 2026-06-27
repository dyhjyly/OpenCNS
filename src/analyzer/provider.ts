import dotenv from 'dotenv';
import { ANALYZER_PROMPT } from './prompt.js';

dotenv.config();

const API_KEY = process.env.DEEPSEEK_API_KEY;

export async function callAnalyzer(content: string) {
  const response = await fetch(
    'https://api.siliconflow.cn/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-ai/DeepSeek-V3',
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: ANALYZER_PROMPT,
          },
          {
            role: 'user',
            content,
          },
        ],
      }),
    }
  );

  return response.json();
}