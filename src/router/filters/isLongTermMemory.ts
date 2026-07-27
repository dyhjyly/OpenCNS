const FACT_KEYWORDS = [
  "我是",
  "我叫",
  "我喜欢",
  "我不喜欢",
  "我准备",
  "我要",
  "我打算",
  "我正在",
  "我已经",
  "我的",
];

const GOAL_KEYWORDS = [
  "目标",
  "计划",
  "学习",
  "工作",
  "健身",
  "减肥",
  "雅思",
  "项目",
  "OpenCNS",
];

export function isLongTermMemory(text: string): {
  ok: boolean;
  reason?: string;
} {
  for (const keyword of FACT_KEYWORDS) {
    if (text.includes(keyword)) {
      return { ok: true };
    }
  }

  for (const keyword of GOAL_KEYWORDS) {
    if (text.includes(keyword)) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    reason: "not-long-term",
  };
}