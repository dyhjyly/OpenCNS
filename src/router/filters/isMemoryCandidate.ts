const BLOCK_LIST = [
  "哈哈",
  "哈哈哈",
  "好的",
  "嗯",
  "嗯嗯",
  "收到",
  "hello，测试321",
  "Dream Review Summary",
];

export function isMemoryCandidate(text: string): {
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

  if (content.length < 8) {
    return {
      ok: false,
      reason: "too-short",
    };
  }

  for (const item of BLOCK_LIST) {
    if (content.includes(item)) {
      return {
        ok: false,
        reason: "block-list",
      };
    }
  }

  return {
    ok: true,
  };
}