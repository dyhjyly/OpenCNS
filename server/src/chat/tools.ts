import { log, errFields } from '../logger.js';
import { chatWithTools, listModels, type ChatMessage, type ToolCall, type ToolDef } from '../llm/client.js';
import { healthContextLines } from '../health/metrics.js';
import { sleepContext } from '../health/sleep.js';
import { cycleContextLines, listDailyStates } from '../calendar/index.js';

/**
 * 他"想看数据的时候问系统要"。
 *
 * 林遇定的规矩：睡眠自动告诉我（她已经发了截图，不该再问一遍），
 * 但步数 / 喝水 / 经期 / 每日状态这些**她自己记就好**，他想要看的时候再查。
 *
 * 所以这里用真的工具调用：模型自己决定要不要查、查哪些。
 * 为了不每轮都多一次模型调用，只在她说的话沾到这些话题时才跑这一趟。
 */

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_health',
      description: '读她最近的身体数据：步数、消耗、喝水量（只保留近两周）',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '看最近几天，1~14' } },
        required: ['days'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sleep',
      description: '读她最近的睡眠记录（时长、深睡、醒来次数）',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '看最近几天，1~30' } },
        required: ['days'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cycle',
      description: '读她的经期记录与推算（上次开始、平均周期、下次大概什么时候）',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_daily_state',
      description: '读她在日历里记的每日状态（心情、精力、一句话）',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '看最近几天，1~60' } },
        required: ['days'],
      },
    },
  },
];

/** 她说的话沾到这些话题时才值得跑一趟工具 */
const TRIGGER = /步数|走路|走了多少|喝水|卡路里|消耗|健康|身体|经期|月经|生理期|周期|日历|每日状态|心情|精力|睡眠|睡得好/;

const SYSTEM = `你在帮江瑜判断：回答她这句话，需要查一下她的身体数据吗？
需要就调用工具去查；不需要就什么工具都别调，直接回一个空字符串。
不要凭印象编数字。`;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function execTool(call: ToolCall): Promise<string> {
  const args = parseArgs(call.arguments);
  const days = Number(args.days ?? 7);
  switch (call.name) {
    case 'get_health': {
      const lines = await healthContextLines(Math.min(14, Math.max(1, days)));
      return lines.length ? lines.join('\n') : '（没有她的身体数据）';
    }
    case 'get_sleep': {
      const ctx = await sleepContext();
      return ctx.lines.length ? ctx.lines.join('\n') : '（没有睡眠记录）';
    }
    case 'get_cycle': {
      const lines = await cycleContextLines();
      return lines.length ? lines.join('\n') : '（没有经期记录）';
    }
    case 'get_daily_state': {
      const rows = await listDailyStates(Math.min(60, Math.max(1, days)));
      if (!rows.length) return '（日历里没有她的每日状态）';
      return rows
        .slice(0, 8)
        .map((r) => `· ${r.day.slice(5)}：${[r.mood, r.energy ? `精力 ${r.energy}/5` : null, r.note].filter(Boolean).join('，')}`)
        .join('\n');
    }
    default:
      return '（未知工具）';
  }
}

export interface ToolPassResult {
  /** 要注进上下文的那段话（空字符串表示没查） */
  block: string;
  used: string[];
}

export async function runToolPass(recent: { role: 'user' | 'assistant'; content: string }[]): Promise<ToolPassResult> {
  const last = recent.filter((m) => m.role === 'user').slice(-1)[0];
  if (!last || !TRIGGER.test(last.content)) return { block: '', used: [] };

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    ...recent.slice(-4).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  let calls: ToolCall[] = [];
  try {
    const out = await chatWithTools(messages, TOOLS, {
      endpoint: 'cognitive',
      temperature: 0,
      maxTokens: 300,
      label: 'chat-tools',
    });
    calls = out.toolCalls;
  } catch (err) {
    log.warn('工具路由失败（不影响对话）', errFields(err));
    return { block: '', used: [] };
  }

  if (calls.length === 0) return { block: '', used: [] };

  const sections: string[] = [];
  const used: string[] = [];
  for (const call of calls.slice(0, 3)) {
    try {
      const text = await execTool(call);
      used.push(call.name);
      sections.push(`【${labelOf(call.name)}】\n${text}`);
    } catch (err) {
      log.warn('执行工具失败', { name: call.name, ...errFields(err) });
    }
  }

  if (sections.length === 0) return { block: '', used: [] };
  return {
    block: ['（下面是你自己去查的，不是她说的）', ...sections].join('\n'),
    used,
  };
}

function labelOf(name: string): string {
  switch (name) {
    case 'get_health': return '你查到的身体数据';
    case 'get_sleep': return '你查到的睡眠';
    case 'get_cycle': return '你查到的经期';
    case 'get_daily_state': return '你查到的每日状态';
    default: return '你查到的';
  }
}

/** 顺带暴露一下模型列表（调试用） */
export { listModels };
