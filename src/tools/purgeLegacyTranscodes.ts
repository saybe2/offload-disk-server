import mongoose from "mongoose";
import { connectDb } from "../db.js";
import { Archive } from "../models/Archive.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Math.trunc(Number(limitArg.split("=")[1] || "0"))) : 0;

function nowIso() {
  return new Date().toISOString();
}

function log(message: string) {
  console.log(`[purge-legacy-transcodes] ${nowIso()} ${message}`);
}

type LegacyDoc = {
  _id: any;
  sourceArchiveId?: any;
  sourceFileIndex?: number | null;
  transcodeAudioTrack?: number | null;
};

type SourcePatchStats = {
  archivesTouched: number;
  filesTouched: number;
  topLevelReset: number;
  variantsRemoved: number;
};

function isLegacyFilter() {
  return {
    archiveKind: "transcoded",
    deletedAt: null,
    $or: [
      { transcodeVersion: { $exists: false } },
      { transcodeVersion: null },
      { transcodeVersion: { $lt: 2 } }
    ]
  } as Record<string, unknown>;
}

async function patchSourceArchives(legacyDocs: LegacyDoc[], applyChanges: boolean) {
  const sourceMap = new Map<string, Map<number, Set<string>>>();
  for (const item of legacyDocs) {
    const sourceId = String(item.sourceArchiveId || "");
    const fileIndex = Number(item.sourceFileIndex);
    if (!sourceId || !Number.isInteger(fileIndex) || fileIndex < 0) continue;
    const legacyId = String(item._id || "");
    if (!legacyId) continue;
    let fileMap = sourceMap.get(sourceId);
    if (!fileMap) {
      fileMap = new Map();
      sourceMap.set(sourceId, fileMap);
    }
    const refs = fileMap.get(fileIndex) || new Set<string>();
    refs.add(legacyId);
    fileMap.set(fileIndex, refs);
  }

  const stats: SourcePatchStats = {
    archivesTouched: 0,
    filesTouched: 0,
    topLevelReset: 0,
    variantsRemoved: 0
  };

  for (const [sourceId, fileMap] of sourceMap.entries()) {
    const source = await Archive.findById(sourceId).select("files");
    if (!source || source.deletedAt) continue;
    const files: any[] = Array.isArray((source as any).files) ? (source as any).files : [];
    let archiveDirty = false;
    let fileDirtyCount = 0;

    for (const [fileIndex, refs] of fileMap.entries()) {
      const file = files[fileIndex];
      if (!file || file.deletedAt) continue;
      let fileDirty = false;
      const transcode = (file as any).transcode || {};
      const topArchiveId = String(transcode.archiveId || "");
      if (topArchiveId && refs.has(topArchiveId)) {
        transcode.archiveId = "";
        transcode.status = "error";
        transcode.error = "legacy_preview_removed";
        transcode.size = 0;
        transcode.contentType = "";
        transcode.updatedAt = new Date();
        (file as any).transcode = transcode;
        stats.topLevelReset += 1;
        fileDirty = true;
      }

      const variants = Array.isArray(transcode.variants) ? transcode.variants : [];
      if (variants.length > 0) {
        const filtered = variants.filter((variant: any) => {
          const variantArchiveId = String(variant?.archiveId || "");
          return !variantArchiveId || !refs.has(variantArchiveId);
        });
        const removed = variants.length - filtered.length;
        if (removed > 0) {
          transcode.variants = filtered;
          transcode.updatedAt = new Date();
          (file as any).transcode = transcode;
          stats.variantsRemoved += removed;
          fileDirty = true;
        }
      }

      if (fileDirty) {
        archiveDirty = true;
        fileDirtyCount += 1;
      }
    }

    if (!archiveDirty) continue;
    stats.archivesTouched += 1;
    stats.filesTouched += fileDirtyCount;

    if (applyChanges) {
      (source as any).markModified("files");
      await source.save();
      log(`source updated id=${sourceId} files=${fileDirtyCount}`);
    } else {
      log(`source would_update id=${sourceId} files=${fileDirtyCount}`);
    }
  }

  return stats;
}

async function markLegacyForDelete(legacyIds: string[], applyChanges: boolean) {
  if (legacyIds.length === 0) return 0;
  if (!applyChanges) return legacyIds.length;
  const now = new Date();
  const result = await Archive.updateMany(
    {
      _id: { $in: legacyIds },
      deletedAt: null,
      archiveKind: "transcoded"
    },
    [
      {
        $set: {
          deleteRequestedAt: now,
          deletedParts: 0,
          deleteTotalParts: { $size: { $ifNull: ["$parts", []] } }
        }
      }
    ]
  );
  return Number(result.modifiedCount || 0);
}

async function run() {
  await connectDb();

  const legacyQuery = isLegacyFilter();
  const find = Archive.find(legacyQuery)
    .select("_id sourceArchiveId sourceFileIndex transcodeAudioTrack")
    .sort({ createdAt: 1 });
  if (limit > 0) {
    find.limit(limit);
  }

  const legacyDocs = (await find.lean()) as LegacyDoc[];
  const legacyIds = legacyDocs.map((item) => String(item._id || "")).filter(Boolean);

  log(`legacy previews found=${legacyIds.length} mode=${apply ? "apply" : "dry-run"}`);

  const sourceStats = await patchSourceArchives(legacyDocs, apply);
  const marked = await markLegacyForDelete(legacyIds, apply);

  log(
    `done mode=${apply ? "apply" : "dry-run"} ` +
      `legacy=${legacyIds.length} marked_for_delete=${marked} ` +
      `source_archives_touched=${sourceStats.archivesTouched} source_files_touched=${sourceStats.filesTouched} ` +
      `top_level_reset=${sourceStats.topLevelReset} variants_removed=${sourceStats.variantsRemoved}`
  );
}

run()
  .catch((err) => {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`[purge-legacy-transcodes] ${nowIso()} fatal ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
