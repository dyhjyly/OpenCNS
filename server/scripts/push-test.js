#!/usr/bin/env node
/**
 * 推送通道自检：零依赖，服务器上直接 node 运行。
 *
 *   node scripts/push-test.js                 # 从 server/.env 读 token 并发一条测试消息
 *   node scripts/push-test.js <token>         # 用指定 token 测试
 *
 * 注意：PushPlus 的 /send 接口用的是「用户token」（一对一推送页面那个），
 *       不是「消息token」（群组/一对多那个）。用错了会返回错误码。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const file = path.resolve(process.cwd(), '.env');
  try {
    const text = readFileSync(file, 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i === -1) continue;
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

const env = loadEnv();
const token = process.argv[2] ?? env.PUSHPLUS_TOKEN ?? '';
const baseUrl = (env.PUSHPLUS_BASE_URL ?? 'https://www.pushplus.plus').replace(/\/+$/, '');

if (!token) {
  console.error('没有 token：在 server/.env 里设置 PUSHPLUS_TOKEN，或用命令行传入。');
  process.exit(2);
}

console.log(`目标: ${baseUrl}/send`);
console.log(`token: ${token.slice(0, 6)}…${token.slice(-4)}（长度 ${token.length}）`);

const res = await fetch(`${baseUrl}/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    token,
    title: 'OpenCNS 通道测试',
    content: `如果你在微信里看到这条消息，说明推送通道接通了。<br>时间：${new Date().toISOString()}`,
    template: 'html',
  }),
});

const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = { raw: text };
}

console.log('HTTP', res.status);
console.log(JSON.stringify(json, null, 2));

if (res.ok && json.code === 200) {
  console.log('\n结果：发送成功 —— 去手机上确认有没有收到。');
} else {
  console.log('\n结果：发送失败。');
  console.log('排查：code=903 通常是 token 类型不对（用了消息token）；code=999/901 是 token 无效或未关注公众号。');
  process.exitCode = 1;
}
