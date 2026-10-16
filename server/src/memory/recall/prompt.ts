/**
 * 召回裁决的提示词。
 *
 * 这一层的作用不是"找相似的"，而是**决定此刻该想起什么**。
 * 相似度高的不一定相关——这是旧版最大的问题（只按向量取前 N 条，
 * 且检索候选阶段就给人加重要度）。
 */

export const RECALL_JUDGE_SYSTEM_PROMPT = `你是长期记忆的取用裁决者。

有人正在说一句话，系统检索出了一批可能相关的记忆。
你的唯一任务：判断**哪几条记忆真的能帮到对这一句话的回应**。

判断标准不是"像不像"，而是：
「如果把这条记忆交给正在回应的人，他会不会因此更懂她在说什么？」

必须遵守：

1. 先理解她这句话真正在说什么、想要什么。
2. 语义相似不等于相关。相似的措辞可能讲的是完全不同的两件事。
3. 重要度高不等于此刻该想起。奠基级的事也不该在她聊天气时被翻出来。
4. 不要为了凑数而选。可以一条都不选，这很正常。
5. 最多选 5 条。
6. 如果她在明确问过去的事（"你还记得吗""我们之前说过"），优先选能直接回答的记忆。
7. 如果一条记忆只是恰好出现了相同的人名或词，不要选。
8. 不要选"系统如何运作""记忆如何被调用"这类元信息，除非她就是在问这些。

只输出 JSON，不要解释：

{ "selectedIds": ["id1", "id2"], "reason": "一句话说明为什么是这几条" }

一条都不选时：

{ "selectedIds": [], "reason": "没有能真正帮到这一轮的记忆" }
`;

export interface JudgeCandidate {
  id: string;
  kind: string;
  content: string;
  event_time: string | null;
  importance: number;
  similarity: number | null;
  routes: string[];
}

export function buildJudgeUserMessage(query: string, candidates: JudgeCandidate[]): string {
  const lines = candidates.map((c, i) => {
    const when = c.event_time ? new Date(c.event_time).toISOString().slice(0, 10) : '时间不详';
    const sim = c.similarity === null ? '-' : c.similarity.toFixed(3);
    return [
      `${i + 1}. id=${c.id}`,
      `   类型=${c.kind}  发生时间=${when}  重要度=${c.importance.toFixed(2)}  相似度=${sim}  命中路径=${c.routes.join('+')}`,
      `   内容：${c.content.slice(0, 600)}`,
    ].join('\n');
  });

  return [
    `她刚说的话：`,
    query,
    '',
    `检索到的候选记忆（${candidates.length} 条）：`,
    ...lines,
    '',
    '请判断哪几条真的能帮到对这句话的回应，只输出 JSON。',
  ].join('\n');
}
