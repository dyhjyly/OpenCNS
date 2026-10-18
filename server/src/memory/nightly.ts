import { many } from '../db/pool.js';
import { chatWithTools, type ChatMessage, type ToolDef, type ToolCall } from '../llm/client.js';
import { saveMemory } from './save.js';
import { log, errFields } from '../logger.js';

/**
 * 凌晨的记忆时间。
 *
 * 林遇的原话："在每晚凌晨他被唤醒时可以提醒他记当天的记忆，
 * 并告诉他存储记忆的规则和格式。他的大脑他来做主。"
 *
 * 所以这里不替他写，只做三件事：
 *   1. 把今天说过的话摆在他面前（原句，不压缩）
 *   2. 告诉他规则和格式
 *   3. 给他 save_memory 工具，记几条、记成什么样，他自己定
 * 一条都不记也是正当的选择。
 */

const SYSTEM = `现在是凌晨。这一天的对话差不多结束了，没有人要求你必须留下什么。

下面是你今天和她说过的话（原句，没有压缩）。

你可以把其中一些记下来，也可以一条都不记。判断标准是你自己的：
· 哪些是你以后想记得的？
· 哪些只是当天的话，忘了也没关系？

如果你要记，可以用 save_memory。规则和格式：

1) kind 选哪个
   · episode     —— 一段有来有回的对话。**必须**同时给 quotes（原句）和 causal（为什么重要）。
                    正文至少 80 字。想保住原句就用这个。
   · semantic    —— 一件事 / 一个事实 / 一条约定。不需要原句。
   · experience  —— 你做过的事、你的感受。
   · reflection  —— 你自己的想法、你想明白的东西。

2) 第一人称
   content 用"我"来写，就像你自己在记事。不要写"林遇…江瑜…"这种第三人称，
   那种东西过几个月你自己都认不出来是你写的。

3) 一定要给 event_time
   今天的日期（YYYY-MM-DD）。没有日期的记忆，以后被想起来时说不清是什么时候的事，
   反而会把当前对话搅乱。

4) importance 0~1
   很平常的 0.3，值得记住的 0.6，很重要的 0.9。

5) 不要记流水账。
   一条记一件事。宁可记三条重要的，也不要记二十条废话。

记完之后不用回复任何人，安静就行。`;

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: '把今天的一件事记进你的记忆',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['episode', 'semantic', 'experience', 'reflection'] },
          content: { type: 'string' },
          quotes: {
            type: 'array',
            items: { type: 'object', properties: { who: { type: 'string' }, text: { type: 'string' } } },
          },
          causal: { type: 'string' },
          event_time: { type: 'string' },
          importance: { type: 'number' },
        },
        required: ['kind', 'content', 'event_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skip',
      description: '今天没什么值得记的，就这样',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface NightlyResult {
  saved: number;
  skipped: boolean;
  calls: number;
  messages: string[];
}

export async function runNightlyMemory(): Promise<NightlyResult> {
  const rows = await many<{ role: string; content: string; event_time: string }>(
    `select role, content, event_time::text
       from messages
      where event_time > now() - interval '20 hours'
        and role in ('user', 'assistant')
      order by seq asc
      limit 120`,
  );

  if (rows.length < 4) {
    log.info('凌晨记忆：今天话太少，跳过');
    return { saved: 0, skipped: true, calls: 0, messages: [] };
  }

  const transcript = rows
    .map((r) => `${r.role === 'user' ? '她' : '我'}：${r.content.replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');

  const today = new Date().toISOString().slice(0, 10);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `今天是 ${today}。\n\n【今天的对话】\n${transcript}` },
  ];

  let calls: ToolCall[] = [];
  try {
    const out = await chatWithTools(messages, TOOLS, {
      endpoint: 'chat',
      temperature: 0.4,
      maxTokens: 3000,
      label: 'nightly-memory',
    });
    calls = out.toolCalls;
  } catch (err) {
    log.error('凌晨记忆调用失败', errFields(err));
    return { saved: 0, skipped: false, calls: 0, messages: ['调用失败'] };
  }

  if (calls.some((c) => c.name === 'skip')) {
    log.info('凌晨记忆：他自己决定今天不记');
    return { saved: 0, skipped: true, calls: calls.length, messages: ['他决定不记'] };
  }

  const results: string[] = [];
  let saved = 0;
  for (const call of calls.filter((c) => c.name === 'save_memory').slice(0, 6)) {
    const a = parseArgs(call.arguments);
    const res = await saveMemory({
      kind: String(a.kind ?? 'semantic'),
      content: String(a.content ?? ''),
      quotes: Array.isArray(a.quotes) ? (a.quotes as { who?: string; text?: string }[]) : undefined,
      causal: typeof a.causal === 'string' ? a.causal : undefined,
      eventTime: typeof a.event_time === 'string' ? a.event_time : today,
      importance: typeof a.importance === 'number' ? a.importance : undefined,
    });
    results.push(res);
    if (res.startsWith('记下了')) saved++;
  }

  log.info('凌晨记忆完成', { saved, calls: calls.length });
  return { saved, skipped: false, calls: calls.length, messages: results };
}
