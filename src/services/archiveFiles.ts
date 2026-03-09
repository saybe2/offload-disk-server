import { isFileDeleted } from "./mediaPreviewSupport.js";

export function isTranscodedArchive(archive: any) {
  return String(archive?.archiveKind || "primary") === "transcoded";
}

export function activeBundleFileIndices(archive: any) {
  const indices: number[] = [];
  const files = Array.isArray(archive?.files) ? archive.files : [];
  for (let i = 0; i < files.length; i += 1) {
    if (!isFileDeleted(files[i])) {
      indices.push(i);
    }
  }
  return indices;
}

export function hasActiveFiles(archive: any) {
  if (!Array.isArray(archive?.files) || archive.files.length === 0) return false;
  return archive.files.some((file: any) => !isFileDeleted(file));
}

