import type { MemLifeDetail, StoredDelta } from './types';

type LifeDetailsDelta = NonNullable<StoredDelta['lifeDetails']>;
type LifeDetailAdd = NonNullable<LifeDetailsDelta['add']>[number];
type LifeDetailUpdate = NonNullable<LifeDetailsDelta['update']>[number];

export interface MergeLifeDetailsOptions {
  /** 当前目标叶子 id，用于识别该叶子 add 数组生成的稳定 id。 */
  leafId?: string;
  /** 重放到目标叶子之前的生活档案，用于恢复更早叶子中被本叶删除的同文案条目。 */
  existingDetails?: MemLifeDetail[];
}

export function normalizeLifeDetailText(text: string): string {
  return text.trim().toLowerCase().replace(/[，。！？!?、；;：:\s]+$/u, '');
}

function upsertUpdate(out: LifeDetailsDelta, update: LifeDetailUpdate): void {
  const updates = (out.update ??= []);
  const index = updates.findIndex(existing => existing.id === update.id);
  if (index >= 0) updates[index] = { ...updates[index], ...update };
  else updates.push(update);
}

function sameLeafAddIndex(id: string, leafId?: string): number | null {
  if (!leafId) return null;
  const prefix = `detail:${leafId}#`;
  if (!id.startsWith(prefix)) return null;
  const index = Number(id.slice(prefix.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function effectiveRemovedText(
  out: LifeDetailsDelta,
  id: string,
  options: MergeLifeDetailsOptions,
): string | undefined {
  const sameLeafIndex = sameLeafAddIndex(id, options.leafId);
  const base = sameLeafIndex === null
    ? options.existingDetails?.find(detail => detail.id === id)?.text
    : out.add?.[sameLeafIndex]?.text;
  const update = out.update?.find(entry => entry.id === id);
  return update?.text ?? base;
}

function reviveRemovedDetail(
  out: LifeDetailsDelta,
  add: LifeDetailAdd,
  options: MergeLifeDetailsOptions,
): boolean {
  const normalized = normalizeLifeDetailText(add.text);
  const id = out.remove?.find(removedId => {
    const text = effectiveRemovedText(out, removedId, options);
    return !!text && normalizeLifeDetailText(text) === normalized;
  });
  if (!id) return false;

  out.remove = out.remove?.filter(existing => existing !== id);
  if (!out.remove?.length) delete out.remove;
  out.archive = out.archive?.filter(existing => existing !== id);
  if (!out.archive?.length) delete out.archive;

  const sameLeafIndex = sameLeafAddIndex(id, options.leafId);
  if (sameLeafIndex !== null && out.add?.[sameLeafIndex]) {
    // 原条目由本叶 add 产生：原位替换，稳定 id 与后续 add 序号都不变。
    out.add[sameLeafIndex] = add;
    if (out.update) {
      out.update = out.update.filter(existing => existing.id !== id);
      if (!out.update.length) delete out.update;
    }
  } else {
    // 原条目来自更早叶子：撤销删除，并用完整补丁恢复成一次全新的 active 手动记录。
    upsertUpdate(out, {
      id,
      text: add.text,
      topics: add.topics ?? [],
      anchors: add.anchors ?? [],
      until: add.until ?? '',
      tier: 'active',
    });
  }
  return true;
}

/**
 * 把一段生活小档案手动操作合并进叶子 delta。
 * update 按 id 压成 last-write-wins；add 不做裁剪，因为条目稳定 id 依赖 add 数组序号。
 */
export function mergeLifeDetailsOp(
  target: StoredDelta,
  incoming: StoredDelta['lifeDetails'],
  options: MergeLifeDetailsOptions = {},
): boolean {
  if (!incoming) return false;
  const hasOps = !!(
    incoming.add?.length
    || incoming.update?.length
    || incoming.archive?.length
    || incoming.remove?.length
  );
  if (!hasOps) return false;

  const out: LifeDetailsDelta = (target.lifeDetails ??= {});

  for (const add of incoming.add ?? []) {
    if (!reviveRemovedDetail(out, add, options)) (out.add ??= []).push(add);
  }

  for (const update of incoming.update ?? []) {
    upsertUpdate(out, update);

    // 手动切换层级必须覆盖同一叶子里 AI 先前给出的 archive 指令。
    if (update.tier && out.archive) {
      out.archive = out.archive.filter(id => id !== update.id);
      if (!out.archive.length) delete out.archive;
    }
  }

  for (const id of incoming.archive ?? []) {
    out.archive = [...(out.archive ?? []).filter(existing => existing !== id), id];
  }

  for (const id of incoming.remove ?? []) {
    out.remove = [...(out.remove ?? []).filter(existing => existing !== id), id];
  }

  return true;
}
