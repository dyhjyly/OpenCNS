import { log } from '../logger.js';

/**
 * 模型输出的 JSON 提取与修复。
 *
 * 单独成文件、不依赖 config/网络，是为了能被单元测试直接 import ——
 * 这段逻辑踩过的坑最多（截断、围栏、前后废话），必须可测。
 */

/**
 * 把被截断的 JSON 尽量补全。
 * 模型输出被长度上限砍断时，硬失败等于丢掉整段记忆 —— 能救则救。
 */
export function repairTruncatedJson(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  const attempt = (text: string): string | null => {
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    for (const c of text) {
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') stack.push('}');
      else if (c === '[') stack.push(']');
      else if (c === '}' || c === ']') stack.pop();
    }
    let out = text;
    if (inStr) out += '"'; // 补上被砍断的字符串
    out = out.replace(/,\s*$/, ''); // 去掉悬空逗号
    out += stack.reverse().join(''); // 闭合所有未结束的结构
    try {
      JSON.parse(out);
      return out;
    } catch {
      return null;
    }
  };

  let candidate = trimmed;
  for (let i = 0; i < 4; i++) {
    const fixed = attempt(candidate);
    if (fixed) return fixed;
    const cut = Math.max(
      candidate.lastIndexOf(','),
      candidate.lastIndexOf('{'),
      candidate.lastIndexOf('['),
    );
    if (cut <= 0) break;
    candidate = candidate.slice(0, cut);
  }
  return null;
}

/** 从模型输出里抠出 JSON：容错 Markdown 围栏、前后废话、被截断的尾巴 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();

  const tryParse = (s: string): T | undefined => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const noFence = trimmed.replace(/```json/gi, '').replace(/```/g, '').trim();
  const unfenced = tryParse(noFence);
  if (unfenced !== undefined) return unfenced;

  const firstObj = noFence.indexOf('{');
  const firstArr = noFence.indexOf('[');
  const start = [firstObj, firstArr].filter((i) => i >= 0).sort((a, b) => a - b)[0];

  if (start !== undefined) {
    const tail = noFence.slice(start);

    const end = Math.max(tail.lastIndexOf('}'), tail.lastIndexOf(']'));
    if (end > 0) {
      const sliced = tryParse(tail.slice(0, end + 1));
      if (sliced !== undefined) return sliced;
    }

    const repaired = repairTruncatedJson(tail);
    if (repaired) {
      const parsed = tryParse(repaired);
      if (parsed !== undefined) {
        log.warn('模型输出的 JSON 被截断，已修复后解析', {
          originalChars: tail.length,
          repairedChars: repaired.length,
        });
        return parsed;
      }
    }
  }

  throw new Error(`无法从模型输出里解析出 JSON（前 200 字）：${text.slice(0, 200)}`);
}
