import { Archive } from "../models/Archive.js";

export async function bumpDownloadCounts(pairs: { archiveId: string; fileIndex: number }[]) {
  const grouped = new Map<string, Set<number>>();
  for (const pair of pairs) {
    if (!pair?.archiveId || !Number.isInteger(pair.fileIndex) || pair.fileIndex < 0) continue;
    const set = grouped.get(pair.archiveId) || new Set<number>();
    set.add(pair.fileIndex);
    grouped.set(pair.archiveId, set);
  }
  if (grouped.size === 0) return;

  const updates: Promise<any>[] = [];
  for (const [archiveId, indices] of grouped.entries()) {
    const inc: Record<string, number> = {};
    for (const index of indices) {
      inc[`files.${index}.downloadCount`] = 1;
    }
    updates.push(Archive.updateOne({ _id: archiveId }, { $inc: inc }));
  }

  await Promise.all(updates);
}
