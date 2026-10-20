import { many } from '../db/pool.js';

/**
 * 今天他自己做过的事。
 *
 * 林遇在聊天里发现：他不记得自己醒来过、不记得给她发过消息、
 * 不记得发过朋友圈、做过东西。
 *
 * 原因不是他记性不好，是这些动作只落在各自的表里（wake_log / outbox / moments），
 * 从来没进过对话上下文。她那边看着更奇怪：明明是他发来的消息，聊天里没有。
 *
 * 所以每轮给一小段"你自己做过什么"，只说事，不灌内容。
 */

export interface SelfActivity {
  lines: string[];
}

export async function selfActivityLines(hours = 24): Promise<string[]> {
  const lines: string[] = [];

  try {
    const wakes = await many<{ decision: string | null; created_at: string; actions: unknown }>(
      `select decision, created_at, actions from wake_log
        where created_at > now() - interval '1 day'
        order by created_at asc`,
    );
    const acted = wakes.filter((w) => w.decision && w.decision !== 'stay_quiet');
    if (acted.length > 0) {
      const tail = acted.slice(-4);
      for (const w of tail) {
        const t = new Date(w.created_at);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const acts = Array.isArray(w.actions) ? (w.actions as string[]).join('/') : '';
        lines.push(`· ${hh}:${mm} 醒来过（${acts || w.decision}）`);
      }
      if (acted.length > tail.length) lines.push(`· 还有 ${acted.length - tail.length} 次，没列`);
    }
  } catch {
    /* 无所谓 */
  }

  try {
    const sent = await many<{ content: string; sent_at: string | null; created_at: string }>(
      `select content, sent_at, created_at from outbox
        where kind = 'message' and created_at > now() - interval '1 day'
        order by created_at asc limit 4`,
    );
    for (const s of sent) {
      const t = new Date(s.sent_at ?? s.created_at);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const text = s.content.replace(/\s+/g, ' ').slice(0, 40);
      lines.push(`· ${hh}:${mm} 你主动给她发过：「${text}」`);
    }
  } catch {
    /* 无所谓 */
  }

  try {
    const moments = await many<{ content: string; created_at: string }>(
      `select content, created_at from moments
        where author = 'self' and deleted_at is null and created_at > now() - interval '1 day'
        order by created_at asc limit 3`,
    );
    for (const m of moments) {
      const text = m.content.replace(/\s+/g, ' ').slice(0, 40);
      lines.push(`· 发过一条动态：「${text}」`);
    }
  } catch {
    /* 无所谓 */
  }

  return lines;
}
