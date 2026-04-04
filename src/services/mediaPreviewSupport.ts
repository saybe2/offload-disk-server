import path from "path";
import mime from "mime-types";
import { config } from "../config.js";
import { getMediaKind } from "./subtitles.js";
import { isHeifFileName, isMediaPreviewSupported, isPreviewAllowedForFile } from "./preview.js";

export function isFileDeleted(file: any) {
  return !!file?.deletedAt;
}

export function getPreviewMediaKind(fileName: string, file: any) {
  const direct = getMediaKind(fileName, file?.detectedKind);
  if (direct) return direct;
  const ext = path.extname(fileName).toLowerCase();
  const label = String(file?.detectedTypeLabel || "").toLowerCase();
  const size = Number(file?.size || 0);
  if (ext === ".ts" && (label.includes("video") || size > 512 * 1024)) {
    return "video" as const;
  }
  return null;
}

export function isPreviewSupportedForFile(archive: any, file: any) {
  if (!file || isFileDeleted(file)) return false;
  if (String(file?.transcode?.status || "") === "ready" && String(file?.transcode?.archiveId || "")) {
    return true;
  }
  const fileName = file.originalName || file.name || archive?.displayName || archive?.name || "";
  const mediaKind = getPreviewMediaKind(fileName, file);
  if (mediaKind) {
    return isMediaPreviewSupported(fileName, mediaKind);
  }
  const fileSize = Number(file.size || 0);
  const previewMaxBytes = Math.max(1, Math.floor(config.previewMaxMiB * 1024 * 1024));
  const contentType = (mime.lookup(fileName) as string) || "";
  if (fileSize > previewMaxBytes && !isHeifFileName(fileName, contentType)) return false;
  return isPreviewAllowedForFile(fileName, contentType);
}

export function isClientStreamAbortError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err || "");
  const code = typeof err === "object" && err ? String((err as any).code || "") : "";
  const lower = message.toLowerCase();
  return (
    lower.includes("premature close") ||
    lower.includes("aborted") ||
    lower.includes("econnreset") ||
    lower.includes("err_stream_premature_close") ||
    code === "ECONNRESET" ||
    code === "ERR_STREAM_PREMATURE_CLOSE"
  );
}
