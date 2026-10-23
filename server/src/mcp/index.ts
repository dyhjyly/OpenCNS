import { many, one, query } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * MCP 客户端（Streamable HTTP 传输）。
 *
 * 她要在前端手动连接一个 MCP 服务器，连上之后给他一个可调用的工具。
 * 所以这里只做三件事：initialize -> tools/list -> tools/call。
 *
 * 传输细节：
 *   · 请求一律 POST，Content-Type: application/json
 *   · 响应可能是 application/json，也可能是 text/event-stream（SSE），两种都认
 *   · 服务器若回 Mcp-Session-Id，后续请求带上
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  status: string;
  tools: McpTool[];
  error: string | null;
  sessionId: string | null;
  connectedAt: string | null;
  createdAt: string;
}

const PROTOCOL_VERSION = '2025-06-18';
let rpcSeq = 1;

function authHeaders(headers: Record<string, string>, sessionId?: string | null): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

/** 从 SSE 文本里挑出这条响应的 JSON */
function pickFromSse(text: string, id: number): unknown {
  for (const frame of text.split(/\n\n/)) {
    const dataLines = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    try {
      const j = JSON.parse(raw) as { id?: number; result?: unknown; error?: unknown };
      if (j.id === undefined || j.id === id) return j;
    } catch {
      /* 忽略非 JSON 帧 */
    }
  }
  return null;
}

async function rpc(
  url: string,
  headers: Record<string, string>,
  method: string,
  params: unknown,
  sessionId?: string | null,
  timeoutMs = 20_000,
): Promise<{ result?: unknown; error?: { message?: string }; sessionId?: string | null }> {
  const id = rpcSeq++;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(headers, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const sid = res.headers.get('mcp-session-id') ?? sessionId ?? null;
  const body = await res.text();

  if (!res.ok) {
    return { error: { message: `HTTP ${res.status}${body ? ` · ${body.slice(0, 160)}` : ''}` }, sessionId: sid };
  }

  const ctype = res.headers.get('content-type') ?? '';
  let payload: unknown = null;
  if (ctype.includes('text/event-stream')) {
    payload = pickFromSse(body, id);
  } else if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      // 有些实现即使 content-type 是 json 也会用 SSE 风格换行
      payload = pickFromSse(body, id);
    }
  }

  if (!payload) return { error: { message: '服务器没有返回可解析的内容' }, sessionId: sid };

  const p = payload as { result?: unknown; error?: { message?: string } };
  if (p.error) return { error: p.error, sessionId: sid };
  return { result: p.result, sessionId: sid };
}

function mapRow(r: {
  id: string;
  name: string;
  url: string;
  headers: unknown;
  enabled: boolean;
  status: string;
  tools: unknown;
  error: string | null;
  session_id: string | null;
  connected_at: string | null;
  created_at: string;
}): McpServer {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    headers: (r.headers ?? {}) as Record<string, string>,
    enabled: r.enabled,
    status: r.status,
    tools: Array.isArray(r.tools) ? (r.tools as McpTool[]) : [],
    error: r.error,
    sessionId: r.session_id,
    connectedAt: r.connected_at,
    createdAt: r.created_at,
  };
}

export async function listServers(): Promise<McpServer[]> {
  const rows = await many<Parameters<typeof mapRow>[0]>(
    `select id::text, name, url, headers, enabled, status, tools, error, session_id, connected_at, created_at
       from mcp_servers order by created_at`,
  );
  return rows.map(mapRow);
}

export async function addServer(input: {
  name: string;
  url: string;
  headers?: Record<string, string>;
}): Promise<McpServer | null> {
  const row = await one<Parameters<typeof mapRow>[0]>(
    `insert into mcp_servers (name, url, headers) values ($1, $2, $3::jsonb)
     returning id::text, name, url, headers, enabled, status, tools, error, session_id, connected_at, created_at`,
    [input.name.trim(), input.url.trim(), JSON.stringify(input.headers ?? {})],
  );
  return row ? mapRow(row) : null;
}

export async function removeServer(id: string): Promise<void> {
  await query(`delete from mcp_servers where id = $1::uuid`, [id]);
}

/** 连接：initialize -> tools/list，把工具清单存下来 */
export async function connect(id: string): Promise<{ ok: boolean; tools?: McpTool[]; error?: string }> {
  const row = await one<Parameters<typeof mapRow>[0]>(
    `select id::text, name, url, headers, enabled, status, tools, error, session_id, connected_at, created_at
       from mcp_servers where id = $1::uuid`,
    [id],
  );
  if (!row) return { ok: false, error: '找不到这个服务器' };
  const s = mapRow(row);

  const init = await rpc(
    s.url,
    s.headers,
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'opencns', version: '2.0' },
    },
    null,
  ).catch((err) => ({ error: { message: String(err?.message ?? err) }, sessionId: null }));

  if (init.error) {
    await query(`update mcp_servers set status = 'error', error = $2 where id = $1::uuid`, [
      id,
      String(init.error.message ?? '连接失败').slice(0, 300),
    ]);
    log.warn('MCP 连接失败', { name: s.name, error: init.error.message });
    return { ok: false, error: String(init.error.message ?? '连接失败') };
  }

  // 有些服务器要求先发 notifications/initialized
  await rpc(s.url, s.headers, 'notifications/initialized', {}, init.sessionId).catch(() => undefined);

  const list = await rpc(s.url, s.headers, 'tools/list', {}, init.sessionId);
  if (list.error) {
    await query(`update mcp_servers set status = 'error', error = $2, session_id = $3 where id = $1::uuid`, [
      id,
      String(list.error.message ?? '取工具清单失败').slice(0, 300),
      init.sessionId,
    ]);
    return { ok: false, error: String(list.error.message ?? '取工具清单失败') };
  }

  const tools = ((list.result as { tools?: McpTool[] })?.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  await query(
    `update mcp_servers
        set status = 'connected', error = null, tools = $2::jsonb, session_id = $3, connected_at = now()
      where id = $1::uuid`,
    [id, JSON.stringify(tools), init.sessionId],
  );
  log.info('MCP 已连接', { name: s.name, tools: tools.length });
  return { ok: true, tools };
}

export async function disconnect(id: string): Promise<void> {
  await query(
    `update mcp_servers set status = 'idle', session_id = null, connected_at = null where id = $1::uuid`,
    [id],
  );
}

/** 调用某个 MCP 工具 */
export async function callTool(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const row = await one<Parameters<typeof mapRow>[0]>(
    `select id::text, name, url, headers, enabled, status, tools, error, session_id, connected_at, created_at
       from mcp_servers where id = $1::uuid`,
    [id],
  );
  if (!row) return '（MCP 服务器不在了）';
  const s = mapRow(row);

  const out = await rpc(s.url, s.headers, 'tools/call', { name: toolName, arguments: args }, s.sessionId);
  if (out.error) {
    log.warn('MCP 工具调用失败', { server: s.name, tool: toolName, error: out.error.message });
    return `（调用 ${toolName} 失败：${String(out.error.message ?? '').slice(0, 200)}）`;
  }

  const result = out.result as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
  const text = (result?.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '［图片］' : `［${c.type ?? '未知'}］`))
    .filter(Boolean)
    .join('\n');
  return text || '（这个工具没有返回文字内容）';
}

/** 给模型用的工具名：mcp__<server8>__<tool> */
export function mcpToolName(serverId: string, tool: string): string {
  const safe = tool.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `mcp__${serverId.slice(0, 8)}__${safe}`;
}

/** 解析回来 */
export function parseMcpToolName(name: string): { serverId8: string; tool: string } | null {
  const m = /^mcp__([0-9a-f]{8})__(.+)$/.exec(name);
  return m ? { serverId8: m[1]!, tool: m[2]! } : null;
}

export async function findServerByPrefix(prefix8: string): Promise<McpServer | null> {
  const rows = await many<Parameters<typeof mapRow>[0]>(
    `select id::text, name, url, headers, enabled, status, tools, error, session_id, connected_at, created_at
       from mcp_servers where id::text like $1 limit 1`,
    [`${prefix8}%`],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
