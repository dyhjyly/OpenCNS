export type PerceptionResult = {
  raw: string;
  intent: string;
  topic: string;
  emotion: string;
  entities: string[];
  timestamp: number;
};

/**
 * Perception Layer v1
 * 将原始输入结构化为认知对象
 */
export async function perceive(input: string): Promise<PerceptionResult> {
  const raw = input;

  // 🧠 简化版 intent detection
  const intent =
    raw.includes("run") ? "action" :
    raw.includes("what") ? "question" :
    raw.includes("why") ? "analysis" :
    "statement";

  // 🧠 简单 topic extraction
  const topic = raw.split(" ")[0] || "unknown";

  // 😊 emotion heuristic (very simple v1)
  const emotion =
    raw.includes("!") ? "excited" :
    raw.includes("?") ? "curious" :
    "neutral";

  // 👤 entity extraction (v1 naive)
  const entities = raw
    .split(" ")
    .filter(w => w.length > 5)
    .slice(0, 3);

  return {
    raw,
    intent,
    topic,
    emotion,
    entities,
    timestamp: Date.now(),
  };
}
