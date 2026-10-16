import { config } from './config.js';

/**
 * 极简结构化日志：一行一个 JSON。
 * 不引第三方依赖，但保留 requestId / traceId 这类字段，方便出问题时按 ID 串起来看。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = ORDER[config.logLevel];

export type Fields = Record<string, unknown>;

function write(level: LogLevel, msg: string, fields: Fields | undefined, base: Fields) {
  if (ORDER[level] < THRESHOLD) return;

  const line: Fields = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...base,
    ...(fields ?? {}),
  };

  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ ts: line.ts, level, msg, note: '日志字段无法序列化' });
  }

  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** 派生一个带固定字段的子 logger（例如 requestId、job_key） */
  child(base: Fields): Logger;
}

export function createLogger(base: Fields = {}): Logger {
  return {
    debug: (msg, fields) => write('debug', msg, fields, base),
    info: (msg, fields) => write('info', msg, fields, base),
    warn: (msg, fields) => write('warn', msg, fields, base),
    error: (msg, fields) => write('error', msg, fields, base),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}

export const log = createLogger({ app: 'opencns' });

/** 把任意异常整理成可日志化的字段 */
export function errFields(err: unknown): Fields {
  if (err instanceof Error) {
    return {
      error: err.message,
      errorName: err.name,
      stack: err.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }
  return { error: String(err) };
}
