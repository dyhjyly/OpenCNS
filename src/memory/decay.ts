function daysSince(date: string | Date) {
  const now = Date.now();
  const past = new Date(date).getTime();
  return Math.max(0, (now - past) / (1000 * 60 * 60 * 24));
}

export function computeDecay(params: {
  importance: number;
  last_accessed: string;
  access_count: number;
}) {
  const days = daysSince(params.last_accessed);

  // 时间衰减
  const timeDecay = Math.exp(-days * 0.03);

  // 使用奖励
  const usageBonus = Math.min(params.access_count * 0.02, 0.3);

  // 最终 importance
  let newImportance =
    params.importance * timeDecay + usageBonus;

  // clamp
  newImportance = Math.max(0, Math.min(1, newImportance));

  return {
    importance: newImportance,
    timeDecay,
    usageBonus,
    daysSinceLastAccess: days,
  };
}
