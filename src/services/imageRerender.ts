import { spawn } from "child_process";
import { createRequire } from "module";
import sharp from "sharp";
import { isHeifFileName } from "./preview.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");
const sharpFormats = (sharp as any).format || {};
const heifInputSupported = !!sharpFormats.heif?.input;

function runFfmpegDecodePng(inputPath: string) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg_missing");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1"
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    proc.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const output = Buffer.concat(chunks);
      if (code === 0 && output.length > 0) {
        resolve(output);
        return;
      }
      reject(new Error(`ffmpeg_failed:${code}:${stderr.slice(-400)}`));
    });
  });
}

async function resolveInput(sourcePath: string, sourceName: string) {
  if (!isHeifFileName(sourceName)) {
    return sourcePath;
  }
  if (heifInputSupported) {
    return sourcePath;
  }
  return runFfmpegDecodePng(sourcePath);
}

function shouldRetryHeifViaFfmpeg(err: unknown) {
  const message = err instanceof Error ? err.message : String(err || "");
  const lower = message.toLowerCase();
  return (
    lower.includes("heif: error while loading plugin") ||
    lower.includes("bad seek") ||
    lower.includes("input file contains unsupported image format") ||
    lower.includes("unsupported image format")
  );
}

export function canServerRenderHeif() {
  return heifInputSupported || !!ffmpegPath;
}

export async function renderImageToWebp(
  sourcePath: string,
  sourceName: string,
  outputPath: string,
  sizePx: number,
  quality: number
) {
  const heif = isHeifFileName(sourceName);
  const input = await resolveInput(sourcePath, sourceName);
  try {
    await sharp(input)
      .rotate()
      .resize(sizePx, sizePx, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toFile(outputPath);
  } catch (err) {
    if (!heif || !ffmpegPath || Buffer.isBuffer(input) || !shouldRetryHeifViaFfmpeg(err)) {
      throw err;
    }
    const fallbackInput = await runFfmpegDecodePng(sourcePath);
    await sharp(fallbackInput)
      .rotate()
      .resize(sizePx, sizePx, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toFile(outputPath);
  }
}

export async function rerenderImageForPreview(
  sourcePath: string,
  sourceName: string,
  outputPath: string
) {
  const heif = isHeifFileName(sourceName);
  const input = await resolveInput(sourcePath, sourceName);
  try {
    await sharp(input)
      .rotate()
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(outputPath);
  } catch (err) {
    if (!heif || !ffmpegPath || Buffer.isBuffer(input) || !shouldRetryHeifViaFfmpeg(err)) {
      throw err;
    }
    const fallbackInput = await runFfmpegDecodePng(sourcePath);
    await sharp(fallbackInput)
      .rotate()
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(outputPath);
  }
}
