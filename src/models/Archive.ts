import mongoose, { Schema } from "mongoose";

export type ArchiveStatus = "queued" | "processing" | "ready" | "error";

export interface ArchiveFile {
  path: string;
  name: string;
  originalName: string;
  size: number;
  contentModifiedAt?: Date;
  downloadCount?: number;
  previewCount?: number;
  detectedKind?: string;
  detectedTypeLabel?: string;
  deletedAt?: Date | null;
  thumbnail?: {
    contentType: string;
    size: number;
    localPath: string;
    url?: string;
    messageId?: string;
    webhookId?: string;
    updatedAt?: Date;
    failedAt?: Date | null;
    error?: string;
  };
  subtitle?: {
    contentType: string;
    size: number;
    localPath: string;
    language?: string;
    provider?: "discord" | "telegram";
    url?: string;
    messageId?: string;
    webhookId?: string;
    telegramFileId?: string;
    telegramChatId?: string;
    mirrorProvider?: "discord" | "telegram";
    mirrorUrl?: string;
    mirrorMessageId?: string;
    mirrorWebhookId?: string;
    mirrorTelegramFileId?: string;
    mirrorTelegramChatId?: string;
    mirrorPending?: boolean;
    mirrorError?: string;
    updatedAt?: Date;
    failedAt?: Date | null;
    error?: string;
  };
  subtitleTracks?: Array<{
    audioTrack: number;
    label?: string;
    language?: string;
    contentType: string;
    size: number;
    localPath: string;
    updatedAt?: Date;
    failedAt?: Date | null;
    error?: string;
  }>;
  transcode?: {
    archiveId?: string;
    status?: "queued" | "processing" | "ready" | "error" | "skipped" | null;
    size?: number;
    contentType?: string;
    updatedAt?: Date | null;
    error?: string;
    variants?: Array<{
      audioTrack: number;
      archiveId?: string;
      status?: "queued" | "processing" | "ready" | "error" | "skipped" | null;
      size?: number;
      contentType?: string;
      updatedAt?: Date | null;
      error?: string;
    }>;
  };
}

export interface ArchivePart {
  index: number;
  size: number;
  plainSize?: number;
  hash: string;
  url: string;
  messageId: string;
  webhookId: string;
  provider?: "discord" | "telegram";
  telegramFileId?: string;
  telegramChatId?: string;
  mirrorProvider?: "discord" | "telegram";
  mirrorUrl?: string;
  mirrorMessageId?: string;
  mirrorWebhookId?: string;
  mirrorTelegramFileId?: string;
  mirrorTelegramChatId?: string;
  mirrorPending?: boolean;
  mirrorError?: string;
  iv?: string;
  authTag?: string;
}

export interface ArchiveDoc extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  displayName: string;
  downloadName: string;
  archiveKind?: "primary" | "transcoded";
  sourceArchiveId?: mongoose.Types.ObjectId | null;
  sourceFileIndex?: number | null;
  transcodeAudioTrack?: number | null;
  isBundle: boolean;
  encryptionVersion?: number;
  folderId?: mongoose.Types.ObjectId | null;
  priority: number;
  priorityOverride: boolean;
  status: ArchiveStatus;
  retryCount: number;
  contentModifiedAt?: Date;
  originalSize: number;
  encryptedSize: number;
  uploadedBytes: number;
  uploadedParts: number;
  totalParts: number;
  deleteTotalParts: number;
  deletedParts: number;
  chunkSizeBytes: number;
  stagingDir: string;
  files: ArchiveFile[];
  parts: ArchivePart[];
  iv: string;
  authTag: string;
  error?: string;
  trashedAt?: Date | null;
  deleteRequestedAt?: Date | null;
  deletedAt?: Date | null;
  deleting?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FileSchema = new Schema<ArchiveFile>(
  {
    path: { type: String, required: true },
    name: { type: String, required: true },
    originalName: { type: String, required: true },
    size: { type: Number, required: true },
    contentModifiedAt: { type: Date, default: Date.now },
    downloadCount: { type: Number, default: 0 },
    previewCount: { type: Number, default: 0 },
    detectedKind: { type: String, default: "" },
    detectedTypeLabel: { type: String, default: "" },
    deletedAt: { type: Date, default: null },
    thumbnail: {
      contentType: { type: String, default: "" },
      size: { type: Number, default: 0 },
      localPath: { type: String, default: "" },
      url: { type: String, default: "" },
      messageId: { type: String, default: "" },
      webhookId: { type: String, default: "" },
      updatedAt: { type: Date, default: null },
      failedAt: { type: Date, default: null },
      error: { type: String, default: "" }
    },
    subtitle: {
      contentType: { type: String, default: "text/vtt; charset=utf-8" },
      size: { type: Number, default: 0 },
      localPath: { type: String, default: "" },
      language: { type: String, default: "auto" },
      provider: { type: String, enum: ["discord", "telegram"], default: null },
      url: { type: String, default: "" },
      messageId: { type: String, default: "" },
      webhookId: { type: String, default: "" },
      telegramFileId: { type: String, default: "" },
      telegramChatId: { type: String, default: "" },
      mirrorProvider: { type: String, enum: ["discord", "telegram"], default: null },
      mirrorUrl: { type: String, default: "" },
      mirrorMessageId: { type: String, default: "" },
      mirrorWebhookId: { type: String, default: "" },
      mirrorTelegramFileId: { type: String, default: "" },
      mirrorTelegramChatId: { type: String, default: "" },
      mirrorPending: { type: Boolean, default: false },
      mirrorError: { type: String, default: "" },
      updatedAt: { type: Date, default: null },
      failedAt: { type: Date, default: null },
      error: { type: String, default: "" }
    },
    subtitleTracks: {
      type: [
        {
          audioTrack: { type: Number, required: true },
          label: { type: String, default: "" },
          language: { type: String, default: "auto" },
          contentType: { type: String, default: "text/vtt; charset=utf-8" },
          size: { type: Number, default: 0 },
          localPath: { type: String, default: "" },
          updatedAt: { type: Date, default: null },
          failedAt: { type: Date, default: null },
          error: { type: String, default: "" }
        }
      ],
      default: []
    },
    transcode: {
      archiveId: { type: String, default: "" },
      status: { type: String, enum: ["queued", "processing", "ready", "error", "skipped"], default: null },
      size: { type: Number, default: 0 },
      contentType: { type: String, default: "" },
      updatedAt: { type: Date, default: null },
      error: { type: String, default: "" },
      variants: {
        type: [
          {
            audioTrack: { type: Number, required: true },
            archiveId: { type: String, default: "" },
            status: { type: String, enum: ["queued", "processing", "ready", "error", "skipped"], default: null },
            size: { type: Number, default: 0 },
            contentType: { type: String, default: "" },
            updatedAt: { type: Date, default: null },
            error: { type: String, default: "" }
          }
        ],
        default: []
      }
    }
  },
  { _id: false }
);

const PartSchema = new Schema<ArchivePart>(
  {
    index: { type: Number, required: true },
    size: { type: Number, required: true },
    plainSize: { type: Number, default: null },
    hash: { type: String, required: true },
    url: { type: String, required: true },
    messageId: { type: String, required: true },
    webhookId: { type: String, required: true },
    provider: { type: String, enum: ["discord", "telegram"], default: "discord" },
    telegramFileId: { type: String, default: "" },
    telegramChatId: { type: String, default: "" },
    mirrorProvider: { type: String, enum: ["discord", "telegram"], default: null },
    mirrorUrl: { type: String, default: "" },
    mirrorMessageId: { type: String, default: "" },
    mirrorWebhookId: { type: String, default: "" },
    mirrorTelegramFileId: { type: String, default: "" },
    mirrorTelegramChatId: { type: String, default: "" },
    mirrorPending: { type: Boolean, default: false },
    mirrorError: { type: String, default: "" },
    iv: { type: String, default: "" },
    authTag: { type: String, default: "" }
  },
  { _id: false }
);

const ArchiveSchema = new Schema<ArchiveDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    downloadName: { type: String, required: true },
    archiveKind: { type: String, enum: ["primary", "transcoded"], default: "primary", index: true },
    sourceArchiveId: { type: Schema.Types.ObjectId, ref: "Archive", default: null, index: true },
    sourceFileIndex: { type: Number, default: null },
    transcodeAudioTrack: { type: Number, default: null, index: true },
    isBundle: { type: Boolean, default: false },
    encryptionVersion: { type: Number, default: 2 },
    folderId: { type: Schema.Types.ObjectId, ref: "Folder", default: null, index: true },
    priority: { type: Number, default: 2, index: true },
    priorityOverride: { type: Boolean, default: false },
    status: { type: String, enum: ["queued", "processing", "ready", "error"], default: "queued", index: true },
    retryCount: { type: Number, default: 0 },
    contentModifiedAt: { type: Date, default: Date.now },
    originalSize: { type: Number, required: true },
    encryptedSize: { type: Number, default: 0 },
    uploadedBytes: { type: Number, default: 0 },
    uploadedParts: { type: Number, default: 0 },
    totalParts: { type: Number, default: 0 },
    deleteTotalParts: { type: Number, default: 0 },
    deletedParts: { type: Number, default: 0 },
    chunkSizeBytes: { type: Number, required: true },
    stagingDir: { type: String, required: true },
    files: { type: [FileSchema], default: [] },
    parts: { type: [PartSchema], default: [] },
    iv: { type: String, default: "" },
    authTag: { type: String, default: "" },
    error: { type: String },
    trashedAt: { type: Date, default: null, index: true },
    deleteRequestedAt: { type: Date, default: null, index: true },
    deletedAt: { type: Date, default: null, index: true },
    deleting: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export const Archive = mongoose.model<ArchiveDoc>("Archive", ArchiveSchema);
