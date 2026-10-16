import { config } from '../config.js';
import { log, errFields } from '../logger.js';
import { many, query } from '../db/pool.js';

/**
 * 投递通道。
 *
 * 一切主动消息都先落 outbox 表，再由 push_dispatch 任务按通道发出去。
 * 这样"他醒来想说的一句话"和"怎么送到她手机上"是解耦的：
 * 换通道、重试、补发都只动这里，不动唤醒逻辑。
 */

export type Channel = 'wechat' | 'webpush' | 'none';
export type OutboxKind = 'message' | 'note' | 'pin_proposal' | 'alert';

export interface OutboxRow {
  id: string;
  kind: OutboxKind;
  content: string;
  channel: Channel;
  attempts: number;
}

/** 入队。同一 dedupeKey 只会入一次（库里有唯一索引兜底）。 */
export async function enqueue(opts: {
  kind: OutboxKind;
  content: string;
  channel?: Channel;
  dedupeKey?: string;
}): Promise<void> {
  const channel = opts.channel ?? (config.push.pushplusToken ? 'wechat' : 'none');
  await query(
    `insert into outbox (kind, content, channel, dedupe_key)
     values ($1, $2, $3, $4)
     on conflict (dedupe_key) where dedupe_key is not null do nothing`,
    [opts.kind, opts.content, channel, opts.dedupeKey ?? null],
  );
}

/** PushPlus（Android · 微信）。token 必须是「用户token」，不是「消息token」。 */
async function sendPushPlus(token: string, title: string, content: string) {
  const res = await fetch(`${config.push.pushplusBaseUrl}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, title, content, template: 'html' }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (!res.ok || json.code !== 200) {
    throw new Error(`pushplus 失败: http=${res.status} code=${json.code} msg=${json.msg ?? ''}`);
  }
  return json;
}

/** 取一批待发消息并投递。失败留痕，等下一轮重试。 */
export async function dispatchPending(limit = 10): Promise<{ sent: number; failed: number }> {
  const rows = await many<OutboxRow>(
    `select id, kind, content, channel, attempts
       from outbox
      where status = 'pending' and attempts < 5
      order by created_at
      limit $1`,
    [limit],
  );

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (row.channel === 'wechat') {
        if (!config.push.pushplusToken) throw new Error('未配置 PUSHPLUS_TOKEN');
        await sendPushPlus(config.push.pushplusToken, titleFor(row.kind), row.content);
      } else if (row.channel === 'webpush') {
        throw new Error('webpush 通道尚未实现（M9 新前端一起做）');
      } else {
        // channel = none：只落库，不推送（她在页面上自己会看到）
      }
      await query(`update outbox set status = 'sent', sent_at = now() where id = $1`, [row.id]);
      sent++;
    } catch (err) {
      failed++;
      log.warn('投递失败', { outboxId: row.id, channel: row.channel, attempts: row.attempts + 1, ...errFields(err) });
      await query(
        `update outbox
            set attempts = attempts + 1,
                status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
                last_error = $2
          where id = $1`,
        [row.id, String((err as Error)?.message ?? err).slice(0, 500)],
      );
    }
  }

  return { sent, failed };
}

function titleFor(kind: OutboxKind): string {
  switch (kind) {
    case 'pin_proposal':
      return '江瑜想记一辈子的一件事';
    case 'note':
      return '江瑜留了张便签';
    case 'alert':
      return 'OpenCNS 告警';
    default:
      return '江瑜';
  }
}

/** 直接发一条测试消息（不走 outbox），用于接通通道后的验证。 */
export async function sendTest(content = '通道测试：如果你在微信里看到这条，说明推送接通了。'): Promise<void> {
  if (!config.push.pushplusToken) throw new Error('未配置 PUSHPLUS_TOKEN');
  await sendPushPlus(config.push.pushplusToken, 'OpenCNS 通道测试', content);
  log.info('测试消息已发出');
}
