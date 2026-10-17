import { many, query } from '../db/pool.js';
import { log, errFields } from '../logger.js';

/**
 * 运行时设置。
 *
 * 读走内存缓存（同步，因为模型客户端在热路径上调用），写同时更新库与缓存。
 * 启动时 loadSettings() 一次；之后只有 PUT 才会变。
 */

const cache = new Map<string, unknown>();
let loaded = false;

/** 允许通过接口修改的键（白名单：别把任意键写进库） */
export const EDITABLE_KEYS = [
  'llm.chat_model',
  'llm.cognitive_model',
  'llm.chat_effort',
  'llm.cognitive_effort',
  'llm.chat_max_tokens',
  'chat.temperature',
  'weather.city',
] as const;

export type EditableKey = (typeof EDITABLE_KEYS)[number];

export async function loadSettings(): Promise<void> {
  const rows = await many<{ key: string; value: unknown }>('select key, value from settings');
  cache.clear();
  for (const r of rows) cache.set(r.key, r.value);
  loaded = true;
  log.info('设置已加载', {
    count: rows.length,
    chatModel: cache.get('llm.chat_model'),
    chatEffort: cache.get('llm.chat_effort'),
  });
}

export function isLoaded(): boolean {
  return loaded;
}

/** 同步读（热路径用）。没加载过就返回兜底值，绝不抛。 */
export function getSetting<T>(key: string, fallback: T): T {
  if (!cache.has(key)) return fallback;
  const v = cache.get(key);
  return (v === undefined || v === null ? fallback : v) as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `insert into settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  cache.set(key, value);
  log.info('设置已更新', { key, value });
}

export async function snapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of cache) out[k] = v;
  try {
    const rows = await many<{ key: string; value: unknown; updated_at: string }>(
      'select key, value, updated_at from settings order by key',
    );
    return { values: out, rows } as unknown as Record<string, unknown>;
  } catch (err) {
    log.warn('读取设置快照失败', errFields(err));
    return { values: out };
  }
}
