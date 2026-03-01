import client from "prom-client";
import { getAnalyticsSnapshot } from "./analytics.js";
import { getMirrorSyncState } from "./mirrorSyncControl.js";

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "offload_node_" });

const gauges = {
  uploadArchivesStarted: new client.Gauge({
    name: "offload_upload_archives_started_total",
    help: "Total upload archives started since process start",
    registers: [registry]
  }),
  uploadArchivesDone: new client.Gauge({
    name: "offload_upload_archives_done_total",
    help: "Total upload archives completed since process start",
    registers: [registry]
  }),
  uploadArchivesError: new client.Gauge({
    name: "offload_upload_archives_error_total",
    help: "Total upload archives failed since process start",
    registers: [registry]
  }),
  uploadRate: new client.Gauge({
    name: "offload_upload_rate_bytes_per_second",
    help: "Upload throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  uploadAvgMs: new client.Gauge({
    name: "offload_upload_archive_avg_ms",
    help: "Average archive upload duration in ms",
    registers: [registry]
  }),
  mirrorPartsDone: new client.Gauge({
    name: "offload_mirror_parts_done_total",
    help: "Total mirror parts synchronized since process start",
    registers: [registry]
  }),
  mirrorPartsError: new client.Gauge({
    name: "offload_mirror_parts_error_total",
    help: "Total mirror parts failed since process start",
    registers: [registry]
  }),
  mirrorRateLimited: new client.Gauge({
    name: "offload_mirror_rate_limited_total",
    help: "Total mirror rate-limit (429) events since process start",
    registers: [registry]
  }),
  mirrorRate: new client.Gauge({
    name: "offload_mirror_rate_bytes_per_second",
    help: "Mirror throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  mirrorAvgMs: new client.Gauge({
    name: "offload_mirror_part_avg_ms",
    help: "Average mirror part duration in ms",
    registers: [registry]
  }),
  mirrorProviderDone: new client.Gauge({
    name: "offload_mirror_provider_done_total",
    help: "Mirror done count by provider since process start",
    labelNames: ["provider"] as const,
    registers: [registry]
  }),
  mirrorProviderError: new client.Gauge({
    name: "offload_mirror_provider_error_total",
    help: "Mirror error count by provider since process start",
    labelNames: ["provider"] as const,
    registers: [registry]
  }),
  mirrorProviderRateLimited: new client.Gauge({
    name: "offload_mirror_provider_rate_limited_total",
    help: "Mirror rate-limit count by provider since process start",
    labelNames: ["provider"] as const,
    registers: [registry]
  }),
  mirrorConcurrency: new client.Gauge({
    name: "offload_mirror_sync_concurrency",
    help: "Current mirror sync concurrency",
    registers: [registry]
  }),
  mirrorPaused: new client.Gauge({
    name: "offload_mirror_sync_paused",
    help: "Mirror sync paused state (1 paused, 0 running)",
    registers: [registry]
  }),
  mirrorAutoTune: new client.Gauge({
    name: "offload_mirror_sync_auto_tune",
    help: "Mirror sync auto tune state (1 enabled, 0 disabled)",
    registers: [registry]
  }),
  downloadStarted: new client.Gauge({
    name: "offload_download_started_total",
    help: "Total downloads started since process start",
    registers: [registry]
  }),
  downloadDone: new client.Gauge({
    name: "offload_download_done_total",
    help: "Total downloads done since process start",
    registers: [registry]
  }),
  downloadError: new client.Gauge({
    name: "offload_download_error_total",
    help: "Total downloads failed since process start",
    registers: [registry]
  }),
  downloadRate: new client.Gauge({
    name: "offload_download_rate_bytes_per_second",
    help: "Download throughput over last 60s in bytes/s",
    registers: [registry]
  })
};

function refreshMetrics() {
  const analytics = getAnalyticsSnapshot();
  const mirrorState = getMirrorSyncState();
  const upload = analytics.upload;
  const mirror = analytics.mirror;
  const download = analytics.download;

  gauges.uploadArchivesStarted.set(upload.archivesStarted || 0);
  gauges.uploadArchivesDone.set(upload.archivesDone || 0);
  gauges.uploadArchivesError.set(upload.archivesError || 0);
  gauges.uploadRate.set(upload.rateBps60s || 0);
  gauges.uploadAvgMs.set(upload.avgArchiveMs || 0);

  gauges.mirrorPartsDone.set(mirror.partsDone || 0);
  gauges.mirrorPartsError.set(mirror.partsError || 0);
  gauges.mirrorRateLimited.set(mirror.rateLimited || 0);
  gauges.mirrorRate.set(mirror.rateBps60s || 0);
  gauges.mirrorAvgMs.set(mirror.avgPartMs || 0);
  gauges.mirrorProviderDone.labels("discord").set(mirror.providers?.discord?.done || 0);
  gauges.mirrorProviderDone.labels("telegram").set(mirror.providers?.telegram?.done || 0);
  gauges.mirrorProviderError.labels("discord").set(mirror.providers?.discord?.error || 0);
  gauges.mirrorProviderError.labels("telegram").set(mirror.providers?.telegram?.error || 0);
  gauges.mirrorProviderRateLimited.labels("discord").set(mirror.providers?.discord?.rateLimited || 0);
  gauges.mirrorProviderRateLimited.labels("telegram").set(mirror.providers?.telegram?.rateLimited || 0);
  gauges.mirrorConcurrency.set(mirrorState.concurrency || 0);
  gauges.mirrorPaused.set(mirrorState.paused ? 1 : 0);
  gauges.mirrorAutoTune.set(mirrorState.autoTune ? 1 : 0);

  gauges.downloadStarted.set(download.started || 0);
  gauges.downloadDone.set(download.done || 0);
  gauges.downloadError.set(download.error || 0);
  gauges.downloadRate.set(download.rateBps60s || 0);
}

export async function getPrometheusMetrics() {
  refreshMetrics();
  return registry.metrics();
}

export function getPrometheusContentType() {
  return registry.contentType;
}

