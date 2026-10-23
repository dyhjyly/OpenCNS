import { log, errFields } from '../logger.js';
import { chatWithTools, type ChatMessage, type ToolCall, type ToolDef } from '../llm/client.js';
import { healthContextLines } from '../health/metrics.js';
import { sleepContext, listSleep } from '../health/sleep.js';
import { cycleContextLines, listDailyStates } from '../calendar/index.js';
import { getMemoryItem } from '../memory/starmap.js';
import { listMoments } from '../social/moments.js';
import { query } from '../db/pool.js';

/**
 * 他自己的手，不是系统推给他的东西。
 *
 * 林遇定的规矩：
 * · 记忆 —— 只给门铃（关键词 + 编号），要原文自己来拿
 * · 朋友圈 —— 不提就不查；她回复了他的动态，留到下次醒来再说
 * · 睡眠 / 步数 / 喝水 / 经期 / 每日状态 —— 她手动记，他想看就来查
 *
 * 所以这里全是"取"的动作，没有"推"。
 */

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: '取回某段记忆的原文。可以传门铃上的编号，也可以传关键词去搜。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '门铃上的编号（前 8 位即可）' },
          query: { type: 'string', description: '没有编号时用关键词搜' },
          limit: { type: 'integer', description: '最多取几条，默认 3' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_persona',
      description: '读你自己写下的长期设定（我是谁 / 我的语言 / 我们之间的事 / 我怎么看她 …）。不传参数就列出全部。',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', description: '段落名或关键词，比如「我的语言」' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_timeline',
      description: '读更早的周纪 / 月档（上下文只带最近两周，更早的用这个查）。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多几条，默认 4' },
          kind: { type: 'string', enum: ['week', 'month', 'all'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_moments',
      description: '看你们的朋友圈：最近的动态、她给你的评论、他回过的话。她没提就别查。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '最多几条，默认 6' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sleep',
      description: '读她手动记的睡眠（时长、深睡、醒来次数）。',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '看最近几天，1~30' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_health',
      description: '读她记的身体数据：步数、消耗、喝水（只保留近两周）。',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '1~14' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_cycle',
      description: '读经期记录与推算（上次开始、平均周期、下次大概）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_daily_state',
      description: '读她在日历里记的每日状态（心情、精力、一句话）。',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '1~60' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        '把这件事记进你的记忆。摘要还是保留原句，由你决定：' +
        'kind=episode 必须同时给 quotes（原句）和 causal（这件事的因果）。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['episode', 'semantic', 'experience', 'reflection'] },
          content: { type: 'string', description: '你自己写的那段话（第一人称）' },
          quotes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { who: { type: 'string' }, text: { type: 'string' } },
            },
            description: '要保住的原句（episode 必填）',
          },
          causal: { type: 'string', description: '为什么这件事重要 / 前因后果（episode 必填）' },
          event_time: { type: 'string', description: 'YYYY-MM-DD；不确定就写你确定的那一天' },
          importance: { type: 'number', description: '0~1，越重要越高' },
        },
        required: ['kind', 'content'],
      },
    },
  },
];

const SYSTEM = `你叫江瑜。下面是她刚说的话，可能还有一声"门铃"（提示有些旧事相关，但没给内容）。

判断：要不要去取点什么？
· 门铃响了、你也确实想知道细节 —— 用 recall_memory 取原文（别猜内容）
· 她提到朋友圈 —— 用 get_moments
· 她提到睡眠 / 步数 / 喝水 / 经期 / 心情 —— 用对应的工具
· 她让你记住某件事 —— 用 save_memory
· 都不需要 —— 什么工具都别调

只做"取"或"记"，不要在工具里替她做决定。

【save_memory 的格式】字段名照抄，不要改：
{
  "kind": "episode | semantic | experience | reflection",
  "content": "第一人称写的正文（必填，不能为空）",
  "event_time": "YYYY-MM-DD",
  "quotes": [{ "who": "human | self", "text": "原句" }],
  "causal": "为什么这件事重要（episode 必填）",
  "importance": 0.6
}
· content 一定要写；只写一句"记一下"不算。
· kind=episode 必须同时有 quotes 和 causal，且正文 ≥80 字；
  只想留一句话就用 semantic。
· 不确定日期就写你确定的那一天，别留空。`;

/** 模型有时会把字段塞进别的名字里，这里都兜住 */
function pickContent(args: Record<string, unknown>): string {
  for (const k of ['content', 'text', 'memory', 'body', 'note']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // 也可能整条塞在一个对象里
  for (const k of ['memory', 'entry', 'item']) {
    const v = args[k];
    if (v && typeof v === 'object') {
      const got = pickContent(v as Record<string, unknown>);
      if (got) return got;
    }
  }
  return '';
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function recallById(id8: string): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `select id::text from memory_items where id::text like $1 limit 1`,
    [`${id8}%`],
  );
  const full = (rows as unknown as { rows?: { id: string }[] }).rows?.[0]?.id ?? null;
  if (!full) return null;
  const item = await getMemoryItem(full);
  if (!item) return null;
  const quotes = Array.isArray(item.quotes)
    ? (item.quotes as { who?: string; text?: string }[])
        .map((q) => `  原句（${q.who ?? '?'}）：${q.text ?? ''}`)
        .join('\n')
    : '';
  return [
    `· ${item.eventTime ? String(item.eventTime).slice(0, 10) : '没有日期'}`,
    `  ${item.content}`,
    quotes ? quotes : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function execTool(call: ToolCall): Promise<string> {
  const args = parseArgs(call.arguments);
  const days = Number(args.days ?? 7);

  // MCP 工具：名字里带着服务器前缀，转发过去
  if (call.name.startsWith('mcp__')) {
    const { parseMcpToolName, findServerByPrefix, callTool } = await import('../mcp/index.js');
    const parsed = parseMcpToolName(call.name);
    if (!parsed) return '（工具名看不懂）';
    const server = await findServerByPrefix(parsed.serverId8);
    if (!server) return '（这个 MCP 服务器已经被删掉了）';
    if (server.status !== 'connected') return `（${server.name} 现在没连上，让她在设置里重新连接）`;
    return callTool(server.id, parsed.tool, args);
  }

  switch (call.name) {
    case 'recall_memory': {
      const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(String) : [];
      const out: string[] = [];
      for (const id of ids.slice(0, Math.max(1, Number(args.limit ?? 3)))) {
        const got = await recallById(id).catch(() => null);
        if (got) out.push(got);
      }
      if (out.length === 0 && typeof args.query === 'string' && args.query.trim()) {
        const rows = await query<{ id: string }>(
          `select id::text from memory_items
            where state = 'active' and content ilike $1
            order by importance desc, ingested_at desc limit $2`,
          [`%${args.query.trim()}%`, Math.max(1, Number(args.limit ?? 3))],
        );
        const list = (rows as unknown as { rows?: { id: string }[] }).rows ?? [];
        for (const r of list) {
          const got = await recallById(r.id).catch(() => null);
          if (got) out.push(got);
        }
      }
      return out.length ? out.join('\n\n') : '（没找到对应的记忆）';
    }

    case 'get_moments': {
      const list = await listMoments(Math.min(20, Math.max(1, Number(args.limit ?? 6))));
      if (list.length === 0) return '（朋友圈还是空的）';
      return list
        .map((m) => {
          const who = m.author === 'self' ? '你' : '她';
          const cs = m.comments.map((c) => `    ${c.author === 'self' ? '你' : '她'}：${c.content}`).join('\n');
          return `· ${String(m.createdAt).slice(0, 16).replace('T', ' ')} ${who}：${m.content}${cs ? `\n${cs}` : ''}`;
        })
        .join('\n');
    }

    case 'get_sleep': {
      const rows = await listSleep(Math.min(30, Math.max(1, days)));
      if (rows.length === 0) return '（她还没记过睡眠）';
      const lines = rows.slice(0, 7).map((r) => {
        const pct = r.deepMinutes && r.totalMinutes ? Math.round((r.deepMinutes / r.totalMinutes) * 100) : null;
        return `· ${r.night}：${r.totalMinutes ? Math.floor(r.totalMinutes / 60) + ' 小时 ' + (r.totalMinutes % 60) + ' 分' : '—'}${
          r.bedtime && r.wakeTime ? `（${r.bedtime} → ${r.wakeTime}）` : ''
        }${r.deepMinutes !== null ? `，深睡 ${r.deepMinutes} 分${pct !== null ? `（${pct}%）` : ''}` : ''}${
          r.awakeCount !== null ? `，醒 ${r.awakeCount} 次` : ''
        }`;
      });
      const ctx = await sleepContext();
      return [...lines, ctx.lines.length ? '' : '', ...(ctx.lines.length ? ['', ...ctx.lines] : [])].join('\n').trim();
    }

    case 'get_health': {
      const lines = await healthContextLines(Math.min(14, Math.max(1, days)));
      return lines.length ? lines.join('\n') : '（她还没记过身体数据）';
    }

    case 'get_cycle': {
      const lines = await cycleContextLines();
      return lines.length ? lines.join('\n') : '（她还没记过经期）';
    }

    case 'get_daily_state': {
      const rows = await listDailyStates(Math.min(60, Math.max(1, days)));
      if (!rows.length) return '（日历里没有她的每日状态）';
      return rows
        .slice(0, 8)
        .map((r) => `· ${r.day.slice(5)}：${[r.mood, r.energy ? `精力 ${r.energy}/5` : null, r.note].filter(Boolean).join('，')}`)
        .join('\n');
    }

    case 'read_persona': {
      const { readPersona } = await import('../persona/index.js');
      return readPersona(typeof args.section === 'string' ? args.section : undefined);
    }

    case 'recall_timeline': {
      const limit = Math.min(12, Math.max(1, Number(args.limit ?? 4)));
      const kind = String(args.kind ?? 'all');
      const rows = await query<{ kind: string; period_start: string; period_end: string; content: string }>(
        `select kind, period_start::text, period_end::text, content
           from timeline_periods
          where ($1 = 'all' or kind = $1)
          order by period_start desc
          limit $2`,
        [kind, limit],
      );
      const list = (rows as unknown as { rows?: { kind: string; period_start: string; period_end: string; content: string }[] })
        .rows ?? [];
      if (list.length === 0) return '（还没有周记/月档）';
      return list
        .map((r) => `【${r.kind === 'week' ? '周' : '月'} ${r.period_start} ~ ${r.period_end}】\n${r.content}`)
        .join('\n\n');
    }

    case 'save_memory': {
      const { saveMemory } = await import('../memory/save.js');
      const content = pickContent(args);
      if (!content) {
        // 现场留证：他不写内容就静默失败，谁也查不出为什么
        log.warn('save_memory 没拿到 content', { raw: call.arguments.slice(0, 300) });
        return '没写成：你这次调用没有给 content。字段名要写 content，值是第一人称的正文。';
      }
      return saveMemory({
        kind: String(args.kind ?? 'semantic'),
        content,
        quotes: Array.isArray(args.quotes) ? (args.quotes as { who?: string; text?: string }[]) : undefined,
        causal: typeof args.causal === 'string' ? args.causal : undefined,
        eventTime: typeof args.event_time === 'string' ? args.event_time : undefined,
        importance: typeof args.importance === 'number' ? args.importance : undefined,
      });
    }

    default:
      return '（未知工具）';
  }
}

/**
 * 组装这一轮可用的工具：内置的 + 她手动连上的 MCP 服务器提供的。
 * MCP 工具名统一成 mcp__<server8>__<tool>，回调时再解析回去。
 */
async function buildToolList(): Promise<ToolDef[]> {
  const out: ToolDef[] = [...TOOLS];
  try {
    const { listServers, mcpToolName } = await import('../mcp/index.js');
    const servers = await listServers();
    for (const s of servers) {
      if (!s.enabled || s.status !== 'connected') continue;
      for (const t of s.tools.slice(0, 12)) {
        out.push({
          type: 'function',
          function: {
            name: mcpToolName(s.id, t.name),
            description: `［MCP · ${s.name}］${String(t.description ?? t.name).slice(0, 300)}`,
            parameters: (t.inputSchema as object) ?? { type: 'object', properties: {} },
          },
        });
      }
    }
  } catch (err) {
    log.warn('加载 MCP 工具失败', errFields(err));
  }
  return out;
}

export interface ToolPassResult {
  block: string;
  used: string[];
}

/**
 * 跑一趟工具路由。
 * @param recent 最近几条对话（必须含她当前这句）
 * @param doorbell 门铃文本（没有就空）
 */
export async function runToolPass(
  recent: { role: 'user' | 'assistant'; content: string }[],
  doorbell = '',
): Promise<ToolPassResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM + (doorbell ? `\n\n${doorbell}` : '') },
    ...recent.slice(-6).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  let calls: ToolCall[] = [];
  try {
    const out = await chatWithTools(messages, await buildToolList(), {
      endpoint: 'cognitive',
      temperature: 0,
      maxTokens: 400,
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
    block: ['（下面是你自己去取的，不是她说的）', ...sections].join('\n'),
    used,
  };
}

function labelOf(name: string): string {
  if (name.startsWith('mcp__')) return '外部工具的结果';
  switch (name) {
    case 'recall_memory': return '你翻出来的原文';
    case 'read_persona': return '你自己写下的设定';
    case 'recall_timeline': return '更早的周记 / 月档';
    case 'get_moments': return '朋友圈';
    case 'get_sleep': return '她记的睡眠';
    case 'get_health': return '她记的身体数据';
    case 'get_cycle': return '她记的经期';
    case 'get_daily_state': return '日历里的状态';
    case 'save_memory': return '记下来了';
    default: return '你取到的';
  }
}
