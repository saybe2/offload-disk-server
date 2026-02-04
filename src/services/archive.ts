import archiver from "archiver";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface FileEntry {
  path: string;
  name: string;
  originalName?: string;
  size: number;
}

export interface PartEntry {
  index: number;
  path: string;
  size: number;
  hash: string;
}

export function zipEntryName(file: FileEntry) {
  return (file.originalName || file.name).replace(/[\\/]/g, "_");
}

export async function createZip(files: FileEntry[], outputPath: string) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const output = fs.createWriteStream(outputPath);
  const archive = archiver("zip", { zlib: { level: 0 } });

  const done = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("warning", reject);
    archive.on("error", reject);
  });

  archive.pipe(output);
  for (const file of files) {
    archive.file(file.path, { name: zipEntryName(file) });
  }
  await archive.finalize();
  await done;
}

export async function splitFileIntoParts(filePath: string, chunkSizeBytes: number, outDir: string) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const parts: PartEntry[] = [];
  let partIndex = 0;
  let currentSize = 0;
  let currentStream: fs.WriteStream | null = null;
  let currentPath = "";
  let hash = crypto.createHash("sha256");
  let streamError: Error | null = null;

  const openNewPart = () => {
    currentPath = path.join(outDir, `part_${partIndex}`);
    currentStream = fs.createWriteStream(currentPath);
    currentStream.on("error", (err) => {
      streamError = err;
    });
    currentSize = 0;
    hash = crypto.createHash("sha256");
  };

  const writeToStream = async (stream: fs.WriteStream, data: Buffer) => {
    if (streamError) throw streamError;
    const ok = stream.write(data);
    if (streamError) throw streamError;
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onErr = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          stream.off("drain", onDrain);
          stream.off("error", onErr);
        };
        stream.once("drain", onDrain);
        stream.once("error", onErr);
      });
    }
    if (streamError) throw streamError;
  };

  const closeStream = (stream: fs.WriteStream) =>
    new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("finish", resolve);
      stream.end();
    });

  openNewPart();
  try {
    const rs = fs.createReadStream(filePath);
    for await (const chunk of rs) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < data.length) {
        if (!currentStream) {
          openNewPart();
        }
        const remaining = chunkSizeBytes - currentSize;
        const slice = data.subarray(offset, offset + remaining);
        await writeToStream(currentStream!, slice);
        hash.update(slice);
        currentSize += slice.length;
        offset += slice.length;

        if (currentSize >= chunkSizeBytes) {
          await closeStream(currentStream!);
          parts.push({
            index: partIndex,
            path: currentPath,
            size: currentSize,
            hash: hash.digest("hex")
          });
          partIndex += 1;
          currentStream = null;
        }
      }
    }
  } catch (err) {
    if (currentStream) {
      currentStream.destroy();
      currentStream = null;
    }
    throw err;
  }

  if (currentStream) {
    await closeStream(currentStream);
    parts.push({
      index: partIndex,
      path: currentPath,
      size: currentSize,
      hash: hash.digest("hex")
    });
  }

  return parts;
}
