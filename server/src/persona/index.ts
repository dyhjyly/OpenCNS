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
