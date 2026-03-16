import { log } from "../logger.js";
import {
  ensureArchiveFileTranscodeForAudioTrack,
  findReadyTranscodeArchive,
  findReadyTranscodeArchiveByAudioTrack
} from "./transcodes.js";

type AudioTrackParseResult =
  | { ok: true; value: number | null }
  | { ok: false };

export function parseAudioTrackQuery(rawValue: unknown): AudioTrackParseResult {
  if (rawValue == null || rawValue === "") {
    return { ok: true, value: null };
  }
  const value = Number.parseInt(String(rawValue), 10);
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

export async function resolvePreferredTranscodedArchiveForMedia(
  archive: any,
  fileIndex: number,
  preferTranscoded: boolean,
  requestedAudioTrack: number | null,
  logPrefix: string
) {
  let transcodedArchive = preferTranscoded ? await findReadyTranscodeArchive(archive, fileIndex) : null;
  if (preferTranscoded && !transcodedArchive && (requestedAudioTrack == null || requestedAudioTrack <= 0)) {
    try {
      await ensureArchiveFileTranscodeForAudioTrack(archive, fileIndex, 0);
      transcodedArchive = await findReadyTranscodeArchive(archive, fileIndex);
    } catch (err) {
      log("transcode", `${logPrefix} ${archive.id} file=${fileIndex} ${(err as Error).message}`);
    }
  }
  if (!preferTranscoded || requestedAudioTrack == null || requestedAudioTrack <= 0) {
    return transcodedArchive;
  }
  let variantArchive = await findReadyTranscodeArchiveByAudioTrack(archive, fileIndex, requestedAudioTrack);
  if (!variantArchive) {
    try {
      await ensureArchiveFileTranscodeForAudioTrack(archive, fileIndex, requestedAudioTrack);
      variantArchive = await findReadyTranscodeArchiveByAudioTrack(archive, fileIndex, requestedAudioTrack);
    } catch (err) {
      log(
        "transcode",
        `${logPrefix} ${archive.id} file=${fileIndex} track=${requestedAudioTrack} ${(err as Error).message}`
      );
    }
  }
  if (variantArchive) {
    transcodedArchive = variantArchive;
  }
  return transcodedArchive;
}
