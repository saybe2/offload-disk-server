import mongoose, { Schema } from "mongoose";

interface ProviderTotals {
  done: number;
  error: number;
  rateLimited: number;
  bytes: number;
}

interface AnalyticsTotalsDoc {
  _id: string;
  upload: {
    archivesStarted: number;
    archivesDone: number;
    archivesError: number;
    bytes: number;
    durationMs: number;
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

const AnalyticsTotalsSchema = new Schema<AnalyticsTotalsDoc>(
  {
    _id: { type: String, required: true },
    upload: {
      archivesStarted: { type: Number, default: 0 },
      archivesDone: { type: Number, default: 0 },
      archivesError: { type: Number, default: 0 },
      bytes: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 }
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
    }
  },
  { timestamps: true, versionKey: false }
);

export const AnalyticsTotals = mongoose.model<AnalyticsTotalsDoc>(
  "AnalyticsTotals",
  AnalyticsTotalsSchema
);
