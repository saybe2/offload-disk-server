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

export function resolvePreviewContentType(fileName: string, contentType: string) {
  if (isPreviewContentTypeAllowed(contentType)) {
    return contentType;
  }
  if (isCodeLikeFileName(fileName)) {
    return "text/plain; charset=utf-8";
  }
  return contentType;
}
