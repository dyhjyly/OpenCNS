/**
 * 视觉能力探针：把一张 PNG 塞进 messages 的 content 数组，看模型能不能读出来。
 * 用法：node scripts/_vision-probe.mjs [model] [imagePath]
 */
import { readFileSync } from 'node:fs';

const model = process.argv[2] ?? 'deepseek-flash';
const imgPath = process.argv[3] ?? '/root/fake-sleep.png';
const base = process.env.PROBE_BASE;
const key = process.env.PROBE_KEY;

const b64 = readFileSync(imgPath).toString('base64');
console.log(`模型 ${model} · 图片 ${imgPath} · ${Math.round(b64.length / 1024)}KB base64`);

const body = {
  model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张截图里，入睡时间、醒来时间、总时长、深睡时长分别是什么？只报数字，一行一个。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    },
  ],
  max_tokens: 400,
};

const started = Date.now();
const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});
const text = await res.text();

if (!res.ok) {
  console.log(`  !! HTTP ${res.status}: ${text.slice(0, 300)}`);
  process.exit(0);
}

const j = JSON.parse(text);
const msg = j.choices?.[0]?.message ?? {};
console.log(`  耗时 ${Date.now() - started}ms · usage ${JSON.stringify(j.usage)}`);
console.log(`  正文: ${JSON.stringify((msg.content ?? '').slice(0, 300))}`);
console.log(`  推理字数: ${(msg.reasoning_content ?? '').length}`);
