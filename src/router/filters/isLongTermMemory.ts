const MEMORY_KEYWORDS = [
  // 身份 / 事实
  "我是",
  "我叫",
  "我喜欢",
  "我不喜欢",
  "我的",

  // 决定 / 计划 / 目标
  "我决定",
  "我准备",
  "我要",
  "我打算",
  "我正在",
  "我已经",
  "目标",
  "计划",

  // 长期项目 / 工作
  "项目",
  "OpenCNS",

  // 规则 / 约定 / 承诺
  "以后",
  "一直",
  "每次",
  "原则",
  "约定",
  "承诺",

  // 关系 / 重要事件
  "第一次",
  "纪念日",
];

export function isLongTermMemory(text: string): {
  ok: boolean;
  reason?: string;
} {
  const content = text.trim();

  if (!content) {
    return {
      ok: false,
      reason: "empty",
    };
  }

  for (const keyword of MEMORY_KEYWORDS) {
    if (content.includes(keyword)) {
      return {
        ok: true,
        reason: `keyword:${keyword}`,
      };
    }
  }

  return {
    ok: false,
    reason: "not-long-term",
  };
}