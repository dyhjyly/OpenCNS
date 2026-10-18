import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { log } from '../logger.js';

/**
 * 登录态。
 *
 * 为什么不用 HTTP Basic：装机到桌面（PWA standalone）之后，Chrome 经常不再
 * 带那组 Basic 凭据 —— 整站 401，看起来就是"前端连不上后端"。
 * 实测日志里全是 `GET /v2/ 401`。
 *
 * 改成 HttpOnly cookie 之后：登录一次，一直有效；PWA、微信内置浏览器、
 * 换网络都不会丢。
 */

const COOKIE = 'oc_session';
const TTL_DAYS = 90;

function secret(): string {
  // 优先专用密钥；没有就拿 API token 派生一个（这样不用多配一个变量）
  const s = process.env.SESSION_SECRET || process.env.API_TOKEN || 'opencns-dev';
  return s;
}

function sign(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

function makeToken(): string {
  // 过期时间 + 随机数，再签名，重启服务也不会把所有人踢下线
  const exp = Date.now() + TTL_DAYS * 86400_000;
  const nonce = randomBytes(9).toString('base64url');
  const payload = `${exp}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function isValidToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [exp, nonce, mac] = parts as [string, string, string];
  const expect = sign(`${exp}.${nonce}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  const t = Number(exp);
  return Number.isFinite(t) && t > Date.now();
}

function cookieOf(req: Request): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function isLoggedIn(req: Request): boolean {
  return isValidToken(cookieOf(req));
}

/** 登录密码：默认沿用原来那组（LOGIN_PASSWORD 可覆盖） */
function password(): string {
  return process.env.LOGIN_PASSWORD || process.env.LOGIN_PASS || 'CVFMlU4eOJm9';
}

export function login(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { password?: string };
  const given = String(body.password ?? '');
  if (!given) {
    res.status(400).json({ ok: false, error: 'password_required' });
    return;
  }
  // 定长比较，避免时序侧信道（单用户场景无所谓，但便宜）
  const a = Buffer.from(given);
  const b = Buffer.from(password());
  const same = a.length === b.length && timingSafeEqual(a, b);
  if (!same) {
    log.warn('登录失败', { ip: req.ip });
    res.status(401).json({ ok: false, error: 'bad_password' });
    return;
  }

  const token = makeToken();
  const secure = (req.headers['x-forwarded-proto'] ?? req.protocol) === 'https';
  res.setHeader(
    'set-cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${TTL_DAYS * 86400}; HttpOnly; SameSite=Lax${
      secure ? '; Secure' : ''
    }`,
  );
  log.info('登录成功', { ip: req.ip });
  res.json({ ok: true });
}

export function logout(_req: Request, res: Response): void {
  res.setHeader('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
}

/** 给 nginx 的 auth_request 用：200 放行，401 拦住 */
export function check(req: Request, res: Response): void {
  if (isLoggedIn(req)) {
    res.status(200).json({ ok: true });
    return;
  }
  res.status(401).json({ ok: false });
}

/** 给前端用：有没有登录 */
export function status(req: Request, res: Response): void {
  res.json({ ok: true, loggedIn: isLoggedIn(req) });
}
