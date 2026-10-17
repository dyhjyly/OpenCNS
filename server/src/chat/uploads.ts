import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { log } from '../logger.js';

/**
 * 附件（图片 / 文件）。
 *
 * 存本地磁盘，不存库：图片动辄几百 KB，塞进 jsonb 会让每次查询变慢。
 * 库里只记 id 和元信息。
 *
 * 上传走 JSON + base64（不引 multer）——单用户场景，一张手环截图几百 KB，
 * 比装一个 multipart 解析器省事得多。
 */

const UPLOAD_DIR = path.resolve(process.cwd(), 'data/uploads');
const MAX_BYTES = 12 * 1024 * 1024;

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
}

export async function ensureUploadDir(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

function extOf(name: string, mime: string): string {
  const fromName = path.extname(name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 8);
  if (fromName) return fromName.toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('text')) return '.txt';
  return '.bin';
}

export async function saveUpload(input: {
  name: string;
  mime: string;
  dataBase64: string;
}): Promise<Attachment> {
  const buf = Buffer.from(input.dataBase64, 'base64');
  if (buf.byteLength === 0) throw new Error('文件是空的');
  if (buf.byteLength > MAX_BYTES) throw new Error('文件太大了（上限 12MB）');

  await ensureUploadDir();
  const id = randomUUID();
  const ext = extOf(input.name || 'file', input.mime || '');
  await writeFile(path.join(UPLOAD_DIR, `${id}${ext}`), buf);

  const kind: Attachment['kind'] = (input.mime || '').startsWith('image/') ? 'image' : 'file';
  log.info('附件已保存', { id: id.slice(0, 8), name: input.name, mime: input.mime, kb: Math.round(buf.byteLength / 1024) });

  return { id, name: input.name, mime: input.mime, size: buf.byteLength, kind };
}

async function findFile(id: string): Promise<{ full: string; ext: string } | null> {
  // 防目录穿越：id 只允许十六进制与短横
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.bin']) {
    const full = path.join(UPLOAD_DIR, `${id}${ext}`);
    try {
      await stat(full);
      return { full, ext };
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/** 读回文件（给图片塞进模型、或给前端回显） */
export async function readUpload(id: string): Promise<{ buf: Buffer; ext: string } | null> {
  const f = await findFile(id);
  if (!f) return null;
  return { buf: await readFile(f.full), ext: f.ext };
}

export function mimeOfExt(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.pdf': return 'application/pdf';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/** 文本类文件直接读成文字（PDF 这类先不解析，只记文件名） */
export async function readTextUpload(id: string, maxChars = 6000): Promise<string | null> {
  const f = await readUpload(id);
  if (!f) return null;
  if (!['.txt', '.md', '.csv', '.json', '.log'].includes(f.ext)) return null;
  return f.buf.toString('utf8').slice(0, maxChars);
}
