const EXTRA_TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "text/xml",
  "application/javascript",
  "application/x-javascript",
  "application/yaml",
  "text/yaml",
  "text/x-yaml",
  "application/x-sh",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values"
]);

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

