import fs from "fs";
import { spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

async function runFfmpeg(args: string[]) {
  if (!ffmpegPath) return false;
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    proc.on("error", () => resolve(false));
    proc.on("close", async (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

export async function remuxTsToMp4(inputPath: string, outputPath: string) {
  if (!ffmpegPath) return false;
  const ok = await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath
  ]);
  if (!ok) return false;
  try {
    const stat = await fs.promises.stat(outputPath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

export async function remuxVideoAudioTrack(inputPath: string, outputPath: string, audioTrack: number) {
  if (!ffmpegPath) return false;
  const track = Math.max(0, Math.floor(audioTrack));
  const baseArgs = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-map",
    "0:v:0?",
    "-map",
    `0:a:${track}`,
    "-movflags",
    "+faststart"
  ];
  const copyOk = await runFfmpeg([
    ...baseArgs,
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    outputPath
  ]);
  if (copyOk) {
    const stat = await fs.promises.stat(outputPath).catch(() => null);
    if (stat && stat.size > 0) return true;
  }
  const transcodeOk = await runFfmpeg([
    ...baseArgs,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    outputPath
  ]);
  if (!transcodeOk) return false;
  const stat = await fs.promises.stat(outputPath).catch(() => null);
  return !!stat && stat.size > 0;
}
