const EXTRA_TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "text/xml",
  "application/javascript",
  "application/typescript",
  "application/x-javascript",
  "text/x-python",
  "application/x-python-code",
  "text/x-php",
  "application/x-httpd-php",
  "text/x-c",
  "text/x-c++src",
  "text/x-java-source",
  "text/x-go",
  "text/x-rustsrc",
  "application/sql",
  "application/yaml",
  "text/yaml",
  "text/x-yaml",
  "application/x-sh",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values"
]);

const CODE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".go",
  ".rs",
  ".php",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".yaml",
  ".yml",
  ".rviz",
  ".xml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
  ".env",
  ".md",
  ".txt",
  ".log"
]);

const BROWSER_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".ogv",
  ".m4v",
  ".mov"
]);

const BROWSER_AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".opus",
  ".m4a",
  ".aac"
]);

function extOf(fileName: string) {
  const lower = String(fileName || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

export function isHeifFileName(fileName: string, contentType = "") {
  const ext = extOf(fileName);
  if (ext === ".heic" || ext === ".heif") {
    return true;
  }
  const normalized = String(contentType || "").toLowerCase();
  return normalized.startsWith("image/heic") || normalized.startsWith("image/heif");
}

function isCodeLikeFileName(fileName: string) {
  if (!fileName) return false;
  const name = String(fileName).trim();
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile" || lower === ".gitignore") {
    return true;
  }
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return CODE_EXTENSIONS.has(lower.slice(dot));
}

export function isPreviewContentTypeAllowed(contentType: string) {
  if (!contentType) return false;
  const base = contentType.toLowerCase().split(";")[0].trim();
  if (!base) return false;
  if (base.startsWith("image/")) return true;
  if (base.startsWith("text/")) return true;
  if (base.startsWith("audio/")) return true;
  if (base.startsWith("video/")) return true;
  if (base === "application/pdf") return true;
  return EXTRA_TEXT_TYPES.has(base);
}

export function isPreviewAllowedForFile(fileName: string, contentType: string) {
  return isPreviewContentTypeAllowed(contentType) || isCodeLikeFileName(fileName);
}

export function isBrowserPlayableMedia(fileName: string, detectedKind?: string) {
  const ext = extOf(fileName);
  if (detectedKind === "video") {
    return BROWSER_VIDEO_EXTENSIONS.has(ext);
  }
  if (detectedKind === "audio") {
    return BROWSER_AUDIO_EXTENSIONS.has(ext);
  }
  if (BROWSER_VIDEO_EXTENSIONS.has(ext) || BROWSER_AUDIO_EXTENSIONS.has(ext)) {
    return true;
  }
  return false;
}

export function isMediaPreviewSupported(fileName: string, mediaKind?: string | null) {
  if (!mediaKind) return false;
  if (isBrowserPlayableMedia(fileName, mediaKind)) return true;
  const ext = extOf(fileName);
  // MPEG-TS is remuxed to MP4 server-side before preview response.
  if (mediaKind === "video" && ext === ".ts") return true;
  return false;
}

export function resolvePreviewContentType(fileName: string, contentType: string) {
  if (isPreviewContentTypeAllowed(contentType)) {
    return contentType;
  }
  if (isCodeLikeFileName(fileName)) {
    return "text/plain; charset=utf-8";
  }
  return contentType;
}
