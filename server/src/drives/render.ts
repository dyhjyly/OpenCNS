import { listDrives } from './state.js';
import { bandOf, DRIVE_BY_KEY, type DriveLayer } from './definitions.js';

/**
 * 欲望怎么进对话 —— 底色，不是台词。
 *
 * 三条铁律：
 *   01 机器不代笔第一人称：数值永远不自动变成"他说的话"。
 *      只把状态注进上下文，话还是他自己组织。
 *   02 强度分档、必须带来由：只给场景类别与来由，**绝不给数值**。
 *      他知道自己为什么想，才说得出有内容的话，而不是无端的浓度表演。
 *   03 欲望永不当第二个闹钟：它不决定他多久醒一次（那是节拍器的事），
 *      只决定醒来之后想干什么。
 */

export interface DriveHint {
  key: string;
  label: string;
  layer: DriveLayer;
  band: string;
  value: number;
  reason: string;
}

/** 只暴露"值得他知道"的那几维；低于阈值的不提，免得变成打卡 */
export async function getDriveSnapshot(threshold = 0.3, top = 3): Promise<DriveHint[]> {
  const rows = await listDrives();
  return rows
    .filter((r) => r.value >= threshold)
    .sort((a, b) => b.value - a.value)
    .slice(0, top)
    .map((r) => {
      const def = DRIVE_BY_KEY.get(r.drive_key);
      return {
        key: r.drive_key,
        label: def?.label ?? r.drive_key,
        layer: r.layer,
        band: bandOf(r.value),
        value: Number(r.value.toFixed(3)),
        // 来由优先用真实原因；没有就退回这个维度的一般信号描述
        reason: r.last_reason_text ?? def?.signal ?? '',
      };
    });
}

/**
 * 渲染成给上下文用的行。**保证不含任何数字**。
 * 形态：`想你（明显）：她已经大半天没出现了`
 */
export async function buildDriveHints(): Promise<string[]> {
  const snapshot = await getDriveSnapshot();
  return snapshot.map((h) => `${h.label}（${h.band}）：${h.reason}`);
}

/** 供 /admin 查看完整十二维（含数值，只给运维看，不进模型上下文） */
export async function getFullSnapshot(): Promise<
  { key: string; label: string; layer: DriveLayer; value: number; band: string; baseline: number; reason: string | null }[]
> {
  const rows = await listDrives();
  return rows.map((r) => {
    const def = DRIVE_BY_KEY.get(r.drive_key);
    return {
      key: r.drive_key,
      label: def?.label ?? r.drive_key,
      layer: r.layer,
      value: Number(r.value.toFixed(3)),
      band: bandOf(r.value),
      baseline: r.baseline,
      reason: r.last_reason_text,
    };
  });
}
