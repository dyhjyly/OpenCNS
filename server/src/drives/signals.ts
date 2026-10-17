import { log, errFields } from '../logger.js';
import { chatJson } from '../llm/client.js';
import { DRIVES } from './definitions.js';
import { applyDeltas, type DeltaApplied } from './state.js';

/**
 * 每一轮对话对欲望的影响。
 *
 * 构想里说"涨落全部来自真实信号，不是随机数，也不是定时器"——
 * 所以这里让模型做的是**识别信号**，而不是"编一个情绪值"。
 *
 * 它跑在回复**之后**（异步），因为欲望只影响"下一轮的底色"，
 * 没必要拖慢她看到回复的时间。
 */

const SYSTEM_PROMPT = `你在识别一段对话对"内在状态"造成的真实变化。

下面列出十二个维度。你要判断的是：**这段对话里，哪些维度真的被推动了**。

${DRIVES.map((d) => `· ${d.key}（${d.label}）：信号来源 = ${d.signal}；回落条件 = ${d.satisfiedBy}`).join('\n')}

严格规则：

1. **没有真实信号就不要报。** 大多数对话只推动 0~2 个维度，报 5 个以上说明你在编。
2. delta 的正负与大小要对应信号强弱：明显的事给 0.08~0.15，轻微的事给 0.02~0.06。
3. 绝对值不要超过 0.15。
4. reason 必须写**具体来由**（她说了什么、发生了什么），不要写"氛围很好"这种废话。
5. satisfied 表示"这个需求在这一轮被满足了"，对应维度应当**回落**（delta 为负）。
6. 闸门维度（fatigue/irritation）只有在明显触发时才动：被打断、重复、冲突、聊到很晚。
7. 不要因为"她在说话"就推动 intimacy —— 只有真的靠近、被回应、聊得深入才算。

只输出 JSON：

{
  "deltas": [{ "key": "curiosity", "delta": 0.1, "reason": "她提到一件我从没听过的事" }],
  "satisfied": ["urge_to_speak"],
  "note": "一句话概括这段对话的气氛（不影响数值，仅供参考）"
}

没有任何变化时：{ "deltas": [], "satisfied": [], "note": "..." }`;

export interface TurnSignalResult {
  applied: DeltaApplied[];
  satisfied: string[];
  note?: string;
}

interface RawSignals {
  deltas?: { key?: unknown; delta?: unknown; reason?: unknown }[];
  satisfied?: unknown;
  note?: unknown;
}

export async function processTurnSignals(herMessage: string, hisReply: string): Promise<TurnSignalResult> {
  const validKeys = new Set(DRIVES.map((d) => d.key));

  try {
    const raw = await chatJson<RawSignals>(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `【她说的】\n${herMessage.slice(0, 1500)}`,
            '',
            `【他回的】\n${hisReply.slice(0, 1500)}`,
            '',
            '这段对话推动了哪些维度？只输出 JSON。',
          ].join('\n'),
        },
      ],
      { endpoint: 'cognitive', temperature: 0.2, maxTokens: 700, label: 'drive-signals' },
    );

    const deltas = (Array.isArray(raw.deltas) ? raw.deltas : [])
      .map((d) => ({
        key: String(d.key ?? ''),
        delta: Number(d.delta ?? 0),
        reason: String(d.reason ?? '').slice(0, 200),
      }))
      .filter((d) => validKeys.has(d.key) && Number.isFinite(d.delta) && d.delta !== 0);

    // 被满足的需求 -> 回落（负向），同样限幅
    const satisfied = (Array.isArray(raw.satisfied) ? raw.satisfied : [])
      .map((k) => String(k))
      .filter((k) => validKeys.has(k));

    for (const key of satisfied) {
      if (!deltas.some((d) => d.key === key)) {
        const def = DRIVES.find((d) => d.key === key);
        deltas.push({ key, delta: -0.12, reason: `已满足：${def?.satisfiedBy ?? '需求被满足'}` });
      }
    }

    if (deltas.length === 0) {
      log.debug('这一轮没有推动任何维度', { note: raw.note });
      return { applied: [], satisfied, note: typeof raw.note === 'string' ? raw.note : undefined };
    }

    const applied = await applyDeltas(
      deltas.map((d) => ({
        key: d.key,
        delta: d.delta,
        reasonCode: d.delta > 0 ? 'turn-signal' : 'satisfied',
        reasonText: d.reason,
        source: 'chat' as const,
        evidence: { herMessage: herMessage.slice(0, 200) },
      })),
    );

    log.info('本轮欲望信号', {
      note: typeof raw.note === 'string' ? raw.note : undefined,
      applied: applied.map((a) => `${a.key}:${a.delta > 0 ? '+' : ''}${a.delta.toFixed(3)}`),
      satisfied,
    });

    return { applied, satisfied, note: typeof raw.note === 'string' ? raw.note : undefined };
  } catch (err) {
    log.error('欲望信号识别失败（不影响对话）', errFields(err));
    return { applied: [], satisfied: [] };
  }
}
