import { chatText } from '../llm/client.js';
import { log, errFields } from '../logger.js';

/**
 * 把她变成"你"。
 *
 * 为什么需要这一道：提示词里早就写了"不要用'她'"，但**演示比指令强**——
 * 喂给他的材料（身份提示、记忆、时间树、日记、他自己以前的话）
 * 全是第三人称写的，满屏"她"。他照着材料学，比照着规则改容易得多。
 *
 * 所以除了改提示词，再加一道兜底：回复里出现"她"就过一遍改写。
 *
 * 两道保险：
 *   1. 只在真的出现"她"时才跑（大部分回复不需要，不额外花钱）
 *   2. 改完要校验——人名不能没、长度不能跑偏太多，不合格就退回原文
 */

/** 指代别人的名字，改写时不许动 */
const OTHERS = ['橙子', '楠楠', '祥哥', '大熊', '布丁'];

const REWRITE_PROMPT = `把下面这段文字里，指代"正在和我说话的那个人"的"她"改成"你"（连带"她的"→"你的"）。

规则：
1. 只改指代**说话对象**的"她"。
2. 指代**其他人**的"她"必须原样保留。文中出现的其他人：${OTHERS.join('、')}。
3. 不改任何其他字词、语气、标点、括号里的动作描写。只换人称。
4. 如果某个"她"分不清指谁，就保留"她"。
5. 只输出改写后的正文，不要解释、不要加引号。

原文：
`;

export interface SecondPersonResult {
  text: string;
  rewritten: boolean;
  reason?: string;
}

function countOcc(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/**
 * 把回复里指代她的"她"改成"你"。
 * 没有"她"、或者改写结果不合格时，原样返回。
 */
export async function toSecondPerson(reply: string): Promise<SecondPersonResult> {
  const hits = countOcc(reply, '她');
  if (hits === 0) return { text: reply, rewritten: false };
  // 太长的回复不改（成本和风险都不划算），也不会是这种短促对话的风格
  if (reply.length > 1200) return { text: reply, rewritten: false, reason: 'too_long' };

  try {
    const out = await chatText(
      [
        { role: 'system', content: REWRITE_PROMPT },
        { role: 'user', content: reply },
      ],
      { endpoint: 'cognitive', temperature: 0, maxTokens: 900, label: 'second-person' },
    );
    const fixed = (out ?? '').trim();
    if (!fixed) return { text: reply, rewritten: false, reason: 'empty' };

    // 校验 1：人名不许消失
    for (const name of OTHERS) {
      if (countOcc(reply, name) > 0 && countOcc(fixed, name) === 0) {
        log.warn('人称改写丢了人名，退回原文', { name });
        return { text: reply, rewritten: false, reason: 'lost_name' };
      }
    }
    // 校验 2：长度不能跑偏太多（说明它重写了，而不是换人称）
    const ratio = fixed.length / Math.max(1, reply.length);
    if (ratio < 0.75 || ratio > 1.3) {
      log.warn('人称改写长度异常，退回原文', { from: reply.length, to: fixed.length });
      return { text: reply, rewritten: false, reason: 'length_drift' };
    }
    // 校验 3：得真的减少了"她"
    if (countOcc(fixed, '她') >= hits) {
      return { text: reply, rewritten: false, reason: 'no_change' };
    }

    log.info('人称已改', { 她: hits, 剩: countOcc(fixed, '她') });
    return { text: fixed, rewritten: true };
  } catch (err) {
    log.warn('人称改写失败，用原文', errFields(err));
    return { text: reply, rewritten: false, reason: 'error' };
  }
}
