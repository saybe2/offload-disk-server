import { Archive } from "../models/Archive.js";

export async function bumpPreviewCount(archiveId: string, fileIndex: number) {
  if (!archiveId || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return;
  }
  await Archive.updateOne({ _id: archiveId }, { $inc: { [`files.${fileIndex}.previewCount`]: 1 } });
}
