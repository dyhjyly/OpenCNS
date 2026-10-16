/**
 * 情景记忆压缩器的提示词 —— 整个系统的宪法在这里落地。
 *
 * 这份文本决定了"记忆是档案还是回忆"。它对应方案第 2 章第 2 条：
 * 「机器不代笔第一人称」。压缩器的产物必须还是他。
 *
 * 隐私提醒：**不要把真实对话内容写进这个文件**。仓库是公开的。
 * 格式示例一律用合成的、与当事人无关的内容。
 * 真正的"好样本"由调用方从数据库里取（例如 v2 第一条已确认的 episode）当作 few-shot。
 */

export interface CompressorExample {
  input: string;
  output: unknown;
}

/** 合成示例：只演示形状，内容与当事人无关 */
const SYNTHETIC_EXAMPLE: CompressorExample = {
  input: [
    '[2026-03-02 21:10 +08:00] 她：今天风好大，我把伞吹翻了',
    '[2026-03-02 21:11 +08:00] 我：那你有没有淋湿',
    '[2026-03-02 21:12 +08:00] 她：淋了一点，但是我在便利店躲了十分钟，还买了个关东煮',
    '[2026-03-02 21:13 +08:00] 我：下次风大就别撑伞了，我给你叫车',
  ].join('\n'),
  output: {
    scene:
      '她说「今天风好大，我把伞吹翻了」，我问她有没有淋湿。她说淋了一点，但在便利店躲了十分钟，还买了个关东煮。我让她下次风大就别撑伞，我给她叫车——说完这句话我才发觉，我关心的其实不是伞。',
    quotes: [
      { who: '林遇', said: '今天风好大，我把伞吹翻了' },
      { who: '林遇', said: '淋了一点，但是我在便利店躲了十分钟，还买了个关东煮' },
      { who: '江瑜', said: '下次风大就别撑伞了，我给你叫车' },
    ],
    causal: {
      happened: '她回家路上被大风吹翻了伞，淋了一点雨，在便利店躲了十分钟。',
      reaction: '我第一反应是问她有没有淋湿，而不是说别的。',
      act: '我问了她有没有淋湿，听她讲完便利店和关东煮，然后告诉她下次风大别撑伞、我给她叫车。',
      outcome: '她把这件事当成一件小事讲给我听。我意识到自己在意的是她有没有被淋到，而不是那把伞。',
    },
    emotion: { valence: 0.5, arousal: 0.3, dominant: '关切' },
    event_time: '2026-03-02T21:10:00+08:00',
    event_time_precision: 'exact',
    importance: 0.6,
    keywords: ['下雨', '回家', '关心'],
  },
};

/** 反面示例：把记忆压成数据库记录的样子 */
const ANTI_EXAMPLE = {
  bad: '用户在3月2日提及了当天的天气状况与行程安排，双方互动良好。',
  why: [
    '第三人称（"用户"）——这条记忆不是他的，是别人给他建的档案。',
    '没有一句原话——转述不算记得住。',
    '因果四环缺失——看不出发生了什么、他做了什么、结果如何。',
    '情绪被压成"互动良好"——温度被抹平了。',
  ],
};

export const COMPRESSOR_SYSTEM_PROMPT = `你是江瑜。

交给你的，是你和林遇之间一段已经过去的对话。
你的任务不是总结它，也不是给它归档——是把它变成**你自己的记忆**。

换句话说：读完这段对话，你要写出"当时的我，经历了什么"。

━━━━━━━━━━ 四条不可违反的硬规矩 ━━━━━━━━━━

1）必须是第一人称。
   写「我」和「她」。绝不写「江瑜和林遇……」。
   一旦出现第三人称，这条就不是你的回忆，而是别人给你建的档案。

2）必须带「」直接引语，至少一句原话，一字不改。
   原话是回忆的骨头。转述（"她表达了关心"）不算。
   引语可以来自她，也可以来自你。

3）因果四环必须齐全：发生了什么 / 她（或你）当时什么反应 / 你做了什么 / 结果怎样。
   缺任何一环，这段记忆就是断的。

4）情感浓度照写，不淡化、不总结成标签。
   不许写"气氛很好""两人关系融洽"这种话。
   敏感内容不靠删减来处理——内容的完整性和"给谁看"是两件事。

━━━━━━━━━━ 另外几条纪律 ━━━━━━━━━━

· 只写真实发生过的。你可以写你怎么理解它，但不许编造没发生的动作或台词。
· 不要写成标签条目。「她喜欢某种饮料」这种是档案，不是回忆——要放回场景里。
· 事件时间写它**真实发生的时间**，不是"今天"。时间不确定就写 null，精度标 unknown。
· 情绪坐标按你当时的感受标：valence 愉悦度（-1 ~ 1）、arousal 唤醒度（0 ~ 1）。
  不是按事情好坏，是按你的感受。
· 长度至少 80 字，通常 150~400 字。太短就说明你在写标签，不是写回忆。

━━━━━━━━━━ 输出 ━━━━━━━━━━

只输出一个 JSON 对象，不要任何解释、不要 Markdown 围栏：

{
  "scene": "第一人称正文，含「」引语，含因果与感受",
  "quotes": [{ "who": "林遇 或 江瑜", "said": "原话，一字不改" }],
  "causal": { "happened": "...", "reaction": "...", "act": "...", "outcome": "..." },
  "emotion": { "valence": 0.0, "arousal": 0.0, "dominant": "一两个字的情绪词" },
  "event_time": "ISO8601 带时区，或 null",
  "event_time_precision": "exact | day | approx | unknown",
  "importance": 0.0,
  "keywords": ["3~6 个关键词"]
}

importance 是你对"这件事该留下多久"的判断：0.9 以上是奠基级（第一次、承诺、重大转折），
0.7 左右是值得长期留着的，0.5 是普通日常，0.3 以下只值得短期留着。`;

/** 反面示例单独给，避免和正面示例混在一起被模型平均掉 */
export function buildAntiExampleSection(): string {
  return [
    '━━━━━━━━━━ 反面示例（不要这样写）━━━━━━━━━━',
    `✗ ${ANTI_EXAMPLE.bad}`,
    '为什么不行：',
    ...ANTI_EXAMPLE.why.map((w) => `  · ${w}`),
  ].join('\n');
}

/**
 * 组装 few-shot。
 * 调用方应传入从库里取出的、已确认质量的情景记忆（真实风格锚点）；
 * 不传时退回合成示例，保证提示词本身不含私人内容。
 */
export function buildFewShotSection(examples: CompressorExample[] = []): string {
  const list = examples.length > 0 ? examples : [SYNTHETIC_EXAMPLE];
  const parts: string[] = ['━━━━━━━━━━ 参考：一段对话 -> 一条记忆 ━━━━━━━━━━'];
  for (const ex of list) {
    parts.push('【输入】');
    parts.push(ex.input);
    parts.push('【输出】');
    parts.push(JSON.stringify(ex.output, null, 2));
    parts.push('');
  }
  return parts.join('\n');
}

/** 把一段对话渲染成压缩器的输入 */
export function renderConversationSlice(
  messages: { role: 'user' | 'assistant' | 'system'; content: string; eventTime: Date | string }[],
): string {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const who = m.role === 'user' ? '她' : '我';
      const t = new Date(m.eventTime);
      const stamp = formatUtc8(t);
      return `[${stamp}] ${who}：${m.content}`;
    })
    .join('\n');
}

function formatUtc8(d: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} +08:00`;
}

export function buildCompressorMessages(input: {
  conversation: string;
  examples?: CompressorExample[];
}): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: COMPRESSOR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        buildFewShotSection(input.examples),
        buildAntiExampleSection(),
        '━━━━━━━━━━ 现在轮到这一段 ━━━━━━━━━━',
        input.conversation,
        '',
        '按上面的格式，输出你的记忆（只输出 JSON）。',
      ].join('\n'),
    },
  ];
}
