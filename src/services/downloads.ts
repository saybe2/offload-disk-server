import fs from "fs";
import type { Request, Response } from "express";
import mime from "mime-types";

function contentDisposition(filename: string) {
  const fallback = filename
    .split("")
    .map((ch) => (/[a-zA-Z0-9._ -]/.test(ch) ? ch : "_"))
    .join("");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, "%2A");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseRange(range: string, size: number) {
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start < 0 || end >= size) return null;
  return { start, end };
}

export async function serveFileWithRange(
  req: Request,
  res: Response,
  filePath: string,
  downloadName: string,
  contentType?: string
) {
  const stat = await fs.promises.stat(filePath);
  const size = stat.size;
  const type = contentType || (mime.lookup(downloadName) as string) || "application/octet-stream";

  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", contentDisposition(downloadName));
  res.setHeader("Accept-Ranges", "bytes");

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    const { start, end } = range;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader("Content-Length", size);
  fs.createReadStream(filePath).pipe(res);
}
