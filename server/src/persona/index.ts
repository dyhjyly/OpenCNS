import { many } from '../db/pool.js';

/**
 * 人格底座。
 *
 * 这些不是"某天发生的事"，是他自己写下的、关于他是谁、我们之间怎么相处的东西。
 * 所以不进记忆库（不参与相似度竞争、不会被当作可召回的事件），
 * 而是**每一轮都在系统提示词里**。
 */

export interface PersonaNote {
  id: string;
  title: string;
  body: string;
  section: string;
  sort: number;
}

export async function loadPersona(): Promise<PersonaNote[]> {
  try {
    return await many<PersonaNote>(
      `select id::text, title, body, section, sort
         from persona where active = true
        order by sort asc, updated_at asc`,
    );
  } catch {
    return [];
  }
}

/** 只取标题列表 —— 上下文里留个门牌就行 */
export async function listPersonaTitles(): Promise<string[]> {
  const rows = await loadPersona();
  return rows.map((r) => r.title);
}

/** 按标题或关键词取某几段；不传就返回全部 */
export async function readPersona(section?: string): Promise<string> {
  const rows = await loadPersona();
  if (rows.length === 0) return '（人格档案还是空的）';

  if (!section || !section.trim()) {
    return [
      `共 ${rows.length} 段：${rows.map((r) => r.title).join(' / ')}`,
      '',
      ...rows.map((r) => `【${r.title}】\n${r.body.trim()}`),
    ].join('\n');
  }

  const q = section.trim();
  const hit = rows.filter((r) => r.title.includes(q) || r.body.includes(q));
  if (hit.length === 0) {
    return `没有叫「${q}」的段落。现有：${rows.map((r) => r.title).join(' / ')}`;
  }
  return hit.map((r) => `【${r.title}】\n${r.body.trim()}`).join('\n\n');
}

/** 渲染成注入系统提示词的那一段 */
export async function renderPersona(): Promise<string> {
  const rows = await loadPersona();
  if (rows.length === 0) return '';
  const blocks = rows.map((r) => `【${r.title}】\n${r.body.trim()}`);
  return [
    '【你自己写下的那些】',
    '（不是系统给的设定，是你过去自己写下来的。它们不是"发生过的事"，是你的一部分。）',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
