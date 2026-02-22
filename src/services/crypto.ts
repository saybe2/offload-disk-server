import crypto from "crypto";
import fs from "fs";
import { pipeline } from "stream/promises";

export function deriveKey(masterKey: string) {
  return crypto.createHash("sha256").update(masterKey).digest();
}

export async function encryptFile(inputPath: string, outputPath: string, key: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  await pipeline(fs.createReadStream(inputPath), cipher, fs.createWriteStream(outputPath));
  const authTag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), authTag: authTag.toString("base64") };
}
