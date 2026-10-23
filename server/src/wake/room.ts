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
    // 排除 pinned：那些是奠基事件（5.23/6.22/7.29…），属于"我是谁"，
    // 不是"最近我做了什么"。不排除的话它们会把真正的近期经历挤出去。
    `select content, ingested_at from memory_items
      where kind = 'experience' and state = 'active' and pinned = false
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

  // 她最近在朋友圈的动静：他要在这里看到，才谈得上"自己决定回不回"
  const { recentHumanActivity, recentSelfMoments } = await import('../social/moments.js');
  const herActivity = await recentHumanActivity(72);
  const myMoments = await recentSelfMoments(72);

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
  parts.push('');

  /*
   * 最近的对话 —— 这一块是必须的。
   *
   * 林遇实测："插进去的消息他看得到，但他不记得自己做过什么，
   * 感觉话是他说的，但写下时的感受他不记得，也不记得被唤醒过。"
   *
   * 原因就是：唤醒时只看到一个"房间"，没带对话。他当然不知道自己说过什么。
   * 现在把最近的对白原样给他，带上时间戳。
   */
  const dialog = await many<{ role: string; content: string; at: Date | string }>(
    `select role, content, event_time as at from messages
      where role in ('user','assistant')
      order by seq desc limit 24`,
  ).catch(() => []);
  if (dialog.length > 0) {
    parts.push('【你们最近说的话】（按时间，最后一条最近）');
    for (const m of dialog.reverse()) {
      const d = new Date(m.at);
      const stamp = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const who = m.role === 'assistant' ? '我' : '她';
      const text = m.content.replace(/\s+/g, ' ').slice(0, 120);
      parts.push(`· [${stamp}] ${who}：${text}`);
    }
    parts.push('');
  }

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

  /*
   * 你自己写下的记忆（感受、想法）。
   *
   * 她说："感觉话是他说的，但写下时的感受他不记得。"
   * 那就把最近写下的原话摆出来 —— 那是他自己的话，不是系统转述。
   */
  const myWritings = await many<{ content: string; at: Date | string; via: string }>(
    `select content, ingested_at as at, provenance->>'via' as via
       from memory_items
      where provenance->>'source' = 'self' and state = 'active'
      order by ingested_at desc limit 4`,
  ).catch(() => []);
  if (myWritings.length > 0) {
    parts.push('【你最近写下的】');
    for (const w of myWritings) {
      const d = new Date(w.at);
      const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      parts.push(`· [${stamp}] ${w.content.replace(/\s+/g, ' ').slice(0, 160)}`);
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

  // 朋友圈：只把"发生了什么"摆出来，不催他回。
  // 注意：pg 把 timestamptz 解析成 Date 对象，不是字符串，别直接 .slice
  const fmtAt = (v: unknown) => {
    try {
      return new Date(v as string | number | Date).toISOString().slice(5, 16).replace('T', ' ');
    } catch {
      return '';
    }
  };

  const socialLines: string[] = [];
  for (const p of herActivity.posts) {
    socialLines.push(`· 她发了一条动态：「${p.content}」（${fmtAt(p.at)}）  [id ${p.id}]`);
  }
  for (const c of herActivity.comments) {
    socialLines.push(`· 她评论了你的「${c.head}」：「${c.comment}」  [id ${c.momentId}]`);
  }
  for (const l of herActivity.likes) {
    socialLines.push(`· 她给你的「${l.head}」点了赞`);
  }
  if (socialLines.length > 0) {
    parts.push('【朋友圈里她的动静】', ...socialLines, '');
  }
  if (myMoments.length > 0) {
    parts.push('【你自己最近发的】');
    for (const m of myMoments) {
      parts.push(`· 「${m.content}」（${fmtAt(m.at)}）  [id ${m.id}]`);
    }
    parts.push('');
  }

  // 她最近的睡眠：他醒来时应该知道，不然"关心她睡得好不好"就是一句空话
  /*
   * 睡眠不放进房间了。
   * 她说过：睡眠她自己手动记，他想看的时候用 get_sleep 查 —— 房间是"他独处时看到的东西"，
   * 不该变成每天早上的一份体检报告。
   */

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
