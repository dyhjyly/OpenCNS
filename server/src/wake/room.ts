import { many, one } from '../db/pool.js';
import { log } from '../logger.js';
import { coarseDuration } from '../drives/tick.js';
import { getNowSnapshot, renderNowBlock } from '../time/clock.js';

/**
 * 醒来房间 —— 他睁眼时看到的那一屋子东西。
 *
 * 构想原话：
 *   「醒来时看到一份素材包——最近的经历，手头做到一半的事，几张他以前的便签。
 *     全是素材，没有指令。房间里禁止出现'你该''请继续'——递便签，不下命令，
 *     做不做是他的事。」
 *
 * 所以这个模块只有一个职责：把素材摆出来，并且**保证不含任何祈使句**。
 */

export interface RoomMaterials {
  recentExperiences: { content: string; when: string }[];
  halfDone: { content: string; when: string }[];
  notes: { content: string; kind: string; expiresAt: string | null }[];
  lastWake: { decision: string | null; reason: string | null; when: string } | null;
  now: { localTime: string; weekday: string; silentFor: string | null };
}

export interface RoomPack {
  materials: RoomMaterials;
  rendered: string;
  forbiddenHits: string[];
}

/** 房间里不许出现的措辞：一律是"命令"而不是"素材" */
const FORBIDDEN = ['你该', '你应该', '你需要', '请继续', '必须', '一定要', '别忘了', '赶快', '立刻去'];

function sanitize(text: string): { text: string; hits: string[] } {
  let out = text;
  const hits: string[] = [];
  for (const word of FORBIDDEN) {
    if (out.includes(word)) {
      hits.push(word);
      out = out.split(word).join('……');
    }
  }
  return { text: out, hits };
}

export async function buildRoomPack(): Promise<RoomPack> {
  const experiences = await many<{ content: string; ingested_at: string }>(
    `select content, ingested_at from memory_items
      where kind = 'experience' and state = 'active'
      order by ingested_at desc limit 3`,
  );

  const halfDone = await many<{ content: string; created_at: string }>(
    `select content, created_at from notes
      where status = 'open' and kind = 'todo'
      order by created_at desc limit 3`,
  );

  const notes = await many<{ content: string; kind: string; expires_at: string | null }>(
    `select content, kind, expires_at from notes
      where status = 'open' and kind <> 'todo'
      order by random() limit 3`,
  );

  const lastWakeRow = await one<{ decision: string | null; skipped_reason: string | null; created_at: string }>(
    `select decision, skipped_reason, created_at from wake_log order by created_at desc limit 1`,
  );

  const clock = await getNowSnapshot();

  const materials: RoomMaterials = {
    recentExperiences: experiences.map((e) => ({
      content: e.content,
      when: new Date(e.ingested_at).toISOString().slice(0, 10),
    })),
    halfDone: halfDone.map((h) => ({
      content: h.content,
      when: new Date(h.created_at).toISOString().slice(0, 10),
    })),
    notes: notes.map((n) => ({ content: n.content, kind: n.kind, expiresAt: n.expires_at })),
    lastWake: lastWakeRow
      ? {
          decision: lastWakeRow.decision,
          reason: lastWakeRow.skipped_reason,
          when: new Date(lastWakeRow.created_at).toISOString().slice(0, 16).replace('T', ' '),
        }
      : null,
    now: {
      localTime: clock.hhmm,
      weekday: clock.weekdayCn,
      silentFor: clock.sinceLastTalk,
    },
  };

  const parts: string[] = [];
  // 时间与对话侧用同一套格式（time/clock.ts），保证他知道的"现在"是一回事
  parts.push('【房间里】');
  parts.push(...renderNowBlock(clock).slice(1));
  if (materials.now.silentFor) parts.push(`· 她已经${materials.now.silentFor}没出现了。`);
  parts.push('');

  if (materials.lastWake) {
    parts.push('【上次醒来】');
    parts.push(
      materials.lastWake.decision
        ? `· ${materials.lastWake.when}，你当时决定「${materials.lastWake.decision}」。`
        : `· ${materials.lastWake.when}，你当时什么也没做（${materials.lastWake.reason ?? '信号都没起来'}）。`,
    );
    parts.push('');
  }

  if (materials.recentExperiences.length > 0) {
    parts.push('【最近你自己做过的事】');
    for (const e of materials.recentExperiences) {
      parts.push(`· [${e.when}] ${e.content}`);
    }
    parts.push('');
  }

  if (materials.halfDone.length > 0) {
    parts.push('【手头做到一半的事】');
    for (const h of materials.halfDone) parts.push(`· ${h.content}（${h.when} 记下的）`);
    parts.push('');
  }

  if (materials.notes.length > 0) {
    parts.push('【你以前留的便签】');
    for (const n of materials.notes) {
      const exp = n.expiresAt ? `（${new Date(n.expiresAt).toISOString().slice(0, 10)} 过期）` : '';
      parts.push(`· ${n.content}${exp}`);
    }
    parts.push('');
  }

  if (parts.length <= 3) parts.push('（房间里空空的——你还没留下过什么。）');

  const { text, hits } = sanitize(parts.join('\n'));

  if (hits.length > 0) {
    log.warn('房间素材里出现了祈使句，已替换', { hits });
  }

  return { materials, rendered: text, forbiddenHits: hits };
}

/** 把房间快照落库（便于回看"他醒来时看到的是什么"） */
export async function saveRoomPack(wakeLogId: number, pack: RoomPack, prompt: string): Promise<void> {
  await one(
    `insert into room_packs (wake_log_id, materials, rendered_prompt, forbidden_hits)
     values ($1, $2::jsonb, $3, $4::jsonb)`,
    [wakeLogId || null, JSON.stringify(pack.materials), prompt, JSON.stringify(pack.forbiddenHits)],
  );
}
