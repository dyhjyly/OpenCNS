/**
 * 最小的 MCP 服务器（Streamable HTTP），只用来验证 OpenCNS 的连接链路。
 *
 *   node tools/mcp-stub.js            # 监听 3599
 *   OpenCNS 里添加：http://127.0.0.1:3599/mcp
 *
 * 实现：initialize / tools/list / tools/call，JSON-RPC 2.0 over POST。
 * 提供的工具：echo（原样回话）、now（当前时间）、roll（掷骰子）。
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 3599);

const TOOLS = [
  {
    name: 'echo',
    description: '把传入的 text 原样返回，用来测试链路。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文字' } },
      required: ['text'],
    },
  },
  {
    name: 'now',
    description: '返回服务器当前的日期和时间（Asia/Shanghai）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'roll',
    description: '掷一个骰子，返回 1 到 sides 之间的整数。',
    inputSchema: {
      type: 'object',
      properties: { sides: { type: 'integer', description: '几面骰子，默认 6' } },
    },
  },
];

function result(id, payload) {
  return { jsonrpc: '2.0', id, result: payload };
}
function error(id, message) {
  return { jsonrpc: '2.0', id, error: { code: -32603, message } };
}

function handle(msg) {
  const { id, method, params } = msg ?? {};

  // 通知类没有 id，不用回
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return null;
    return null;
  }

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'opencns-stub', version: '1.0.0' },
      });
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') {
        return result(id, { content: [{ type: 'text', text: String(args.text ?? '') }] });
      }
      if (name === 'now') {
        const t = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        return result(id, { content: [{ type: 'text', text: t }] });
      }
      if (name === 'roll') {
        const sides = Math.max(2, Math.min(1000, Number(args.sides ?? 6)));
        return result(id, { content: [{ type: 'text', text: String(1 + Math.floor(Math.random() * sides)) }] });
      }
      return error(id, `没有这个工具：${name}`);
    }
    default:
      return error(id, `不认识的方法：${method}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('POST only');
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(error(null, 'bad json')));
      return;
    }
    const out = handle(msg);
    if (!out) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': 'stub-session-1',
    }).end(JSON.stringify(out));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MCP stub 在 http://127.0.0.1:${PORT}/mcp`);
});
