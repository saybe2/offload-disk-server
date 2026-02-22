import fs from "fs";
import { spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

export async function remuxTsToMp4(inputPath: string, outputPath: string) {
  if (!ffmpegPath) return false;
  return new Promise<boolean>((resolve) => {
    const args = [
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
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    proc.on("error", () => resolve(false));
    proc.on("close", async (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }
      try {
        const stat = await fs.promises.stat(outputPath);
        resolve(stat.size > 0);
      } catch {
        resolve(false);
      }
    });
  });
}
