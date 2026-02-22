import fs from "fs";
import path from "path";

export type DetectedKind = "image" | "video" | "audio" | "code" | "archive" | "document" | "binary";

export interface DetectedFileType {
  kind: DetectedKind;
  label: string;
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".heif", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".wmv", ".flv", ".mpeg", ".mpg", ".m2ts", ".3gp", ".ogv", ".vob"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".oga", ".opus", ".wma", ".aiff"]);
const ARCHIVE_EXT = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz"]);
const DOC_EXT = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".rtf", ".csv"]);
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".php", ".java", ".cs", ".cpp", ".cc", ".c", ".h",
  ".hpp", ".go", ".rs", ".rb", ".swift", ".kt", ".sql", ".html", ".css", ".scss", ".less", ".json", ".xml",
  ".yaml", ".yml", ".toml", ".ini", ".sh", ".ps1", ".bat", ".cmd", ".md"
]);

function extOf(fileName: string) {
  const lower = String(fileName || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

async function readSample(filePath: string, maxBytes = 188 * 12) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isLikelyMpegTransportStream(sample: Buffer) {
  if (sample.length < 188 * 4) return false;
  for (let offset = 0; offset < 188; offset += 1) {
    let hits = 0;
    for (let pos = offset; pos < sample.length; pos += 188) {
      if (sample[pos] === 0x47) {
        hits += 1;
      } else {
        break;
      }
    }
    if (hits >= 4) return true;
  }
  return false;
}

function isLikelyText(sample: Buffer) {
  if (sample.length === 0) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0x00) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      control += 1;
    }
  }
  return control / sample.length < 0.02;
}

function detectFromExtension(fileName: string): DetectedFileType {
  const ext = extOf(fileName);
  if (IMAGE_EXT.has(ext)) return { kind: "image", label: "Image" };
  if (VIDEO_EXT.has(ext)) return { kind: "video", label: "Video" };
  if (AUDIO_EXT.has(ext)) return { kind: "audio", label: "Audio" };
  if (ARCHIVE_EXT.has(ext)) return { kind: "archive", label: "Archive" };
  if (DOC_EXT.has(ext)) return { kind: "document", label: "Document" };
  if (CODE_EXT.has(ext)) return { kind: "code", label: ext === ".md" ? "Markdown" : "Code" };
  return { kind: "binary", label: "Binary" };
}

export function detectFileTypeFromName(fileName: string): DetectedFileType {
  const ext = extOf(fileName);
  if (ext === ".ts") {
    return { kind: "code", label: "TypeScript" };
  }
  return detectFromExtension(fileName);
}

export function detectFileTypeFromSample(fileName: string, sample: Buffer): DetectedFileType {
  const ext = extOf(fileName);
  if (ext !== ".ts") {
    return detectFromExtension(fileName);
  }
  if (isLikelyMpegTransportStream(sample)) {
    return { kind: "video", label: "MPEG-TS video" };
  }
  if (isLikelyText(sample)) {
    return { kind: "code", label: "TypeScript" };
  }
  return { kind: "code", label: "TypeScript" };
}

export async function detectStoredFileType(filePath: string, fileName: string): Promise<DetectedFileType> {
  const ext = extOf(fileName);
  if (ext !== ".ts") {
    return detectFromExtension(fileName);
  }

  try {
    const sample = await readSample(filePath);
    return detectFileTypeFromSample(fileName, sample);
  } catch {
    // fallback to extension when file is unavailable
  }
  return { kind: "code", label: "TypeScript" };
}

export function detectTypeLabelForUi(file: { detectedTypeLabel?: string; originalName?: string; name?: string }) {
  if (file?.detectedTypeLabel) return file.detectedTypeLabel;
  return detectFileTypeFromName(file?.originalName || file?.name || path.basename(file?.name || "")).label;
}
