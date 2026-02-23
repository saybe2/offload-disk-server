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
}

export interface ArchivePart {
  index: number;
  size: number;
  plainSize?: number;
  hash: string;
  url: string;
  messageId: string;
  webhookId: string;
  iv?: string;
  authTag?: string;
}

export interface ArchiveDoc extends mongoose.Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  displayName: string;
  downloadName: string;
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
