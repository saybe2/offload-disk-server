import mongoose, { Schema } from "mongoose";

interface ProviderTotals {
  done: number;
  error: number;
  rateLimited: number;
  bytes: number;
}

interface UploadProviderTotals {
  done: number;
  error: number;
  rateLimited: number;
  bytes: number;
}

interface SubtitleProviderTotals {
  attempted: number;
  failed: number;
}

interface AnalyticsTotalsDoc {
  _id: string;
  upload: {
    archivesStarted: number;
    archivesDone: number;
    archivesError: number;
    bytes: number;
    durationMs: number;
    providers: {
      discord: UploadProviderTotals;
      telegram: UploadProviderTotals;
    };
  };
  mirror: {
    partsDone: number;
    partsError: number;
    rateLimited: number;
    bytes: number;
    durationMs: number;
    providers: {
      discord: ProviderTotals;
      telegram: ProviderTotals;
    };
  };
  download: {
    started: number;
    done: number;
    error: number;
    bytesPlanned: number;
  };
  restore: {
    jobsStarted: number;
    jobsDone: number;
    jobsError: number;
    bytes: number;
    durationMs: number;
  };
  preview: {
    started: number;
    done: number;
    error: number;
    bytes: number;
  };
  thumbnail: {
    jobsStarted: number;
    jobsDone: number;
    jobsError: number;
    bytes: number;
    durationMs: number;
  };
  subtitle: {
    jobsStarted: number;
    jobsDone: number;
    jobsError: number;
    sourceBytes: number;
    bytes: number;
    durationMs: number;
    providers: {
      asr: SubtitleProviderTotals;
      local: SubtitleProviderTotals;
    };
  };
  transcode: {
    jobsStarted: number;
    jobsDone: number;
    jobsError: number;
    bytesIn: number;
    bytesOut: number;
    durationMs: number;
    errorTypes?: Record<string, number>;
  };
  deletion: {
    jobsStarted: number;
    jobsDone: number;
    jobsError: number;
    partsDone: number;
    bytesFreed: number;
    durationMs: number;
  };
  smb: {
    readOpens: number;
    writeOpens: number;
    readOps: number;
    writeOps: number;
    readBytes: number;
    writeBytes: number;
    errors: number;
  };
}

const ProviderTotalsSchema = new Schema<ProviderTotals>(
  {
    done: { type: Number, default: 0 },
    error: { type: Number, default: 0 },
    rateLimited: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 }
  },
  { _id: false }
);

const UploadProviderTotalsSchema = new Schema<UploadProviderTotals>(
  {
    done: { type: Number, default: 0 },
    error: { type: Number, default: 0 },
    rateLimited: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 }
  },
  { _id: false }
);

const SubtitleProviderTotalsSchema = new Schema<SubtitleProviderTotals>(
  {
    attempted: { type: Number, default: 0 },
    failed: { type: Number, default: 0 }
  },
  { _id: false }
);

const AnalyticsTotalsSchema = new Schema<AnalyticsTotalsDoc>(
  {
    _id: { type: String, required: true },
    upload: {
      archivesStarted: { type: Number, default: 0 },
      archivesDone: { type: Number, default: 0 },
      archivesError: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 },
      providers: {
        discord: { type: UploadProviderTotalsSchema, default: () => ({}) },
        telegram: { type: UploadProviderTotalsSchema, default: () => ({}) }
      }
    },
    mirror: {
      partsDone: { type: Number, default: 0 },
      partsError: { type: Number, default: 0 },
      rateLimited: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 },
      providers: {
        discord: { type: ProviderTotalsSchema, default: () => ({}) },
        telegram: { type: ProviderTotalsSchema, default: () => ({}) }
      }
    },
    download: {
      started: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      error: { type: Number, default: 0 },
      bytesPlanned: { type: Number, default: 0 }
    },
    restore: {
      jobsStarted: { type: Number, default: 0 },
      jobsDone: { type: Number, default: 0 },
      jobsError: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 }
    },
    preview: {
      started: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      error: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 }
    },
    thumbnail: {
      jobsStarted: { type: Number, default: 0 },
      jobsDone: { type: Number, default: 0 },
      jobsError: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 }
    },
    subtitle: {
      jobsStarted: { type: Number, default: 0 },
      jobsDone: { type: Number, default: 0 },
      jobsError: { type: Number, default: 0 },
      sourceBytes: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 },
      providers: {
        asr: { type: SubtitleProviderTotalsSchema, default: () => ({}) },
        local: { type: SubtitleProviderTotalsSchema, default: () => ({}) }
      }
    },
    transcode: {
      jobsStarted: { type: Number, default: 0 },
      jobsDone: { type: Number, default: 0 },
      jobsError: { type: Number, default: 0 },
      bytesIn: { type: Number, default: 0 },
      bytesOut: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 },
      errorTypes: { type: Map, of: Number, default: {} }
    },
    deletion: {
      jobsStarted: { type: Number, default: 0 },
      jobsDone: { type: Number, default: 0 },
      jobsError: { type: Number, default: 0 },
      partsDone: { type: Number, default: 0 },
      bytesFreed: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 }
    },
    smb: {
      readOpens: { type: Number, default: 0 },
      writeOpens: { type: Number, default: 0 },
      readOps: { type: Number, default: 0 },
      writeOps: { type: Number, default: 0 },
      readBytes: { type: Number, default: 0 },
      writeBytes: { type: Number, default: 0 },
      errors: { type: Number, default: 0 }
    }
  },
  { timestamps: true, versionKey: false }
);

export const AnalyticsTotals = mongoose.model<AnalyticsTotalsDoc>(
  "AnalyticsTotals",
  AnalyticsTotalsSchema
);
