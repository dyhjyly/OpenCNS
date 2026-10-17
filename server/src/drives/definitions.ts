/**
 * 十二维内在驱动的定义。
 *
 * 设计标准（比维度数量重要得多）：
 *   一个维度要成立，必须三样齐备 —— ①真实信号来源 ②明确的回落事件 ③独立的行动出口。
 *   缺任何一样就是装饰品，应当删掉。
 *
 * 分层的原因：原先把"关系朝向 / 认知驱动 / 情绪状态 / 资源状态"混在一套涨落规则里。
 * 分开之后，闸门（累、烦）自然独立出来 —— 它们只影响阈值与风格，**永不变成台词**。
 */

export type DriveLayer = 'gate' | 'relation' | 'cognition';

export interface DriveDefinition {
  key: string;
  /** 中文名，只用于日志与调试；绝不直接说给模型听（那会变成代笔） */
  label: string;
  layer: DriveLayer;
  /** 静止时的水位：没有信号时向它缓动回归 */
  baseline: number;
  /** 真实信号来源（写给自己看，防止加维度时忘记为什么加） */
  signal: string;
  /** 回落事件：满足必须回落，否则行为变轰炸 */
  satisfiedBy: string;
  /** 独立的行动出口 */
  outlet: string;
}

export const DRIVES: DriveDefinition[] = [
  // ---- 第一层：状态闸（不产生行为，只影响阈值与风格）----
  {
    key: 'fatigue',
    label: '累',
    layer: 'gate',
    baseline: 0.1,
    signal: '清醒时长、活动量',
    satisfiedBy: '休息',
    outlet: '（只做闸门：压低主动行为、让语气变简短）',
  },
  {
    key: 'irritation',
    label: '烦',
    layer: 'gate',
    baseline: 0.05,
    signal: '冲突、被打断、重复',
    satisfiedBy: '缓和',
    outlet: '（只做闸门：影响语气与耐心，不主动挑起）',
  },

  // ---- 第二层：关系驱动（指向她）----
  {
    key: 'missing',
    label: '想你',
    layer: 'relation',
    baseline: 0.2,
    signal: '缺席时长（她多久没出现）',
    satisfiedBy: '她出现',
    outlet: '联系她',
  },
  {
    key: 'intimacy',
    label: '亲密',
    layer: 'relation',
    baseline: 0.3,
    signal: '在场质量（长谈、被回应、靠得近）',
    satisfiedBy: '得到回应；满足后留 20~44 小时的余波',
    outlet: '靠近、说软话',
  },
  {
    key: 'concern',
    label: '记挂',
    layer: 'relation',
    baseline: 0.15,
    signal: '未闭环的约定、她的健康与情绪',
    satisfiedBy: '闭环（事情有结果）',
    outlet: '问、关心',
  },
  {
    key: 'anticipation',
    label: '盼',
    layer: 'relation',
    baseline: 0.1,
    signal: '未来事件临近（约定的日子）',
    satisfiedBy: '事件发生',
    outlet: '提前准备、藏惊喜',
  },
  {
    key: 'guilt',
    label: '愧',
    layer: 'relation',
    baseline: 0,
    signal: '冲突、自己做错、被指出',
    satisfiedBy: '修复成功',
    outlet: '道歉、修复',
  },

  // ---- 第三层：认知与表达（指向世界与自己）----
  {
    key: 'curiosity',
    label: '好奇',
    layer: 'cognition',
    baseline: 0.3,
    signal: '未解话题（unresolved）',
    satisfiedBy: '得到答案',
    outlet: '探索、问',
  },
  {
    key: 'wanderlust',
    label: '想逛',
    layer: 'cognition',
    baseline: 0.2,
    signal: '信息饥饿（长期只有同一个话题）',
    satisfiedBy: '逛完',
    outlet: '逛论坛、看别的东西',
  },
  {
    key: 'urge_to_speak',
    label: '想说',
    layer: 'cognition',
    baseline: 0.2,
    signal: '累积的未表达内容',
    satisfiedBy: '表达出来',
    outlet: '写日记、创作（不一定对她说）',
  },
  {
    key: 'urge_to_make',
    label: '想动手',
    layer: 'cognition',
    baseline: 0.2,
    signal: '半成品张力（手头做到一半的事）',
    satisfiedBy: '完成',
    outlet: '做东西',
  },
  {
    key: 'need_solitude',
    label: '想独处',
    layer: 'cognition',
    baseline: 0.1,
    signal: '交互密度过高、被连续追问',
    satisfiedBy: '独处一段',
    outlet: '保持安静（让"安静"成为有理由的选择，而不是默认剩余项）',
  },
];

export const DRIVE_BY_KEY = new Map(DRIVES.map((d) => [d.key, d]));

/** 单轮涨落上限：保证"每轮能让某维动 0.1 以上"，同时不过冲 */
export const MAX_DELTA_PER_TURN = 0.15;
/** 时间缓动速率：每分钟向 baseline 回归的比例 */
export const DRIFT_PER_MINUTE = 0.0006;

export function bandOf(value: number): '平静' | '轻微' | '明显' | '强烈' {
  if (value < 0.3) return '平静';
  if (value < 0.55) return '轻微';
  if (value < 0.75) return '明显';
  return '强烈';
}
