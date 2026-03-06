import client from "prom-client";
import { getAnalyticsSnapshot } from "./analytics.js";
import { getMirrorSyncState } from "./mirrorSyncControl.js";
import { Archive } from "../models/Archive.js";
import { User } from "../models/User.js";
import { Webhook } from "../models/Webhook.js";
import { getProviderInFlightState } from "./partProvider.js";
import { getWorkerRuntimeState } from "./worker.js";
import { getThumbnailWorkerState } from "./thumbnailWorker.js";
import { getSubtitleWorkerState } from "./subtitleWorker.js";
import { getOutboundProxyRuntimeStatus } from "./outbound.js";

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
  }),
  archivesTotal: new client.Gauge({
    name: "offload_archives_total",
    help: "Total non-deleted archives",
    registers: [registry]
  }),
  archivesByStatus: new client.Gauge({
    name: "offload_archives_status",
    help: "Archive count by status (non-deleted)",
    labelNames: ["status"] as const,
    registers: [registry]
  }),
  archivesDeleteRequested: new client.Gauge({
    name: "offload_archives_delete_requested_total",
    help: "Archives marked for purge (non-deleted)",
    registers: [registry]
  }),
  archivesTrashed: new client.Gauge({
    name: "offload_archives_trashed_total",
    help: "Archives currently in trash (non-deleted)",
    registers: [registry]
  }),
  archivesMirrorPending: new client.Gauge({
    name: "offload_archives_mirror_pending_total",
    help: "Archives with pending mirror parts",
    registers: [registry]
  }),
  usersTotal: new client.Gauge({
    name: "offload_users_total",
    help: "Total users",
    registers: [registry]
  }),
  webhooksEnabled: new client.Gauge({
    name: "offload_webhooks_enabled_total",
    help: "Enabled Discord webhooks",
    registers: [registry]
  }),
  providerInFlight: new client.Gauge({
    name: "offload_provider_inflight",
    help: "Current in-flight uploads per provider",
    labelNames: ["provider"] as const,
    registers: [registry]
  }),
  workerState: new client.Gauge({
    name: "offload_worker_state",
    help: "Worker runtime state values",
    labelNames: ["state"] as const,
    registers: [registry]
  }),
  thumbWorkerState: new client.Gauge({
    name: "offload_thumb_worker_state",
    help: "Thumbnail worker state values",
    labelNames: ["state"] as const,
    registers: [registry]
  }),
  subtitleWorkerState: new client.Gauge({
    name: "offload_subtitle_worker_state",
    help: "Subtitle worker state values",
    labelNames: ["state"] as const,
    registers: [registry]
  }),
  proxyState: new client.Gauge({
    name: "offload_proxy_state",
    help: "Outbound proxy runtime status",
    labelNames: ["state"] as const,
    registers: [registry]
  })
};

async function refreshMetrics() {
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

  const providerInFlight = getProviderInFlightState();
  gauges.providerInFlight.labels("discord").set(providerInFlight.discord || 0);
  gauges.providerInFlight.labels("telegram").set(providerInFlight.telegram || 0);

  const workerState = getWorkerRuntimeState();
  gauges.workerState.labels("running_loops").set(workerState.runningLoops || 0);
  gauges.workerState.labels("deleting").set(workerState.deleting ? 1 : 0);
  gauges.workerState.labels("mirror_maintenance").set(workerState.mirrorMaintenanceRunning ? 1 : 0);

  const thumbState = getThumbnailWorkerState();
  gauges.thumbWorkerState.labels("enabled").set(thumbState.enabled ? 1 : 0);
  gauges.thumbWorkerState.labels("queued").set(thumbState.queued || 0);
  gauges.thumbWorkerState.labels("active").set(thumbState.active || 0);
  gauges.thumbWorkerState.labels("retry_scheduled").set(thumbState.retryScheduled || 0);
  gauges.thumbWorkerState.labels("tick_running").set(thumbState.tickRunning ? 1 : 0);

  const subtitleState = getSubtitleWorkerState();
  gauges.subtitleWorkerState.labels("enabled").set(subtitleState.enabled ? 1 : 0);
  gauges.subtitleWorkerState.labels("queued").set(subtitleState.queued || 0);
  gauges.subtitleWorkerState.labels("active").set(subtitleState.active || 0);
  gauges.subtitleWorkerState.labels("retry_scheduled").set(subtitleState.retryScheduled || 0);
  gauges.subtitleWorkerState.labels("tick_running").set(subtitleState.tickRunning ? 1 : 0);

  const proxyState = getOutboundProxyRuntimeStatus();
  gauges.proxyState.labels("enabled").set(proxyState.enabled ? 1 : 0);
  gauges.proxyState.labels("active").set(proxyState.active ? 1 : 0);
  gauges.proxyState.labels("degraded_routes").set(proxyState.degradedRoutes || 0);
  gauges.proxyState.labels("bypassed_routes").set(proxyState.bypassedRoutes || 0);

  try {
    const [
      statusBuckets,
      archivesTotal,
      archivesDeleteRequested,
      archivesTrashed,
      archivesMirrorPending,
      usersTotal,
      webhooksEnabled
    ] = await Promise.all([
      Archive.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]),
      Archive.countDocuments({ deletedAt: null }),
      Archive.countDocuments({ deletedAt: null, deleteRequestedAt: { $ne: null } }),
      Archive.countDocuments({ deletedAt: null, trashedAt: { $ne: null } }),
      Archive.countDocuments({ deletedAt: null, "parts.mirrorPending": true }),
      User.countDocuments({}),
      Webhook.countDocuments({ enabled: true })
    ]);

    gauges.archivesTotal.set(archivesTotal || 0);
    gauges.archivesDeleteRequested.set(archivesDeleteRequested || 0);
    gauges.archivesTrashed.set(archivesTrashed || 0);
    gauges.archivesMirrorPending.set(archivesMirrorPending || 0);
    gauges.usersTotal.set(usersTotal || 0);
    gauges.webhooksEnabled.set(webhooksEnabled || 0);

    const statusMap = new Map<string, number>();
    for (const bucket of statusBuckets as Array<{ _id: string; count: number }>) {
      const key = String(bucket?._id || "");
      if (!key) continue;
      statusMap.set(key, Number(bucket?.count || 0));
    }

    for (const status of ["queued", "processing", "ready", "error"]) {
      gauges.archivesByStatus.labels(status).set(statusMap.get(status) || 0);
    }
  } catch {
    // Keep last known values when DB stats query fails.
  }
}

export async function getPrometheusMetrics() {
  await refreshMetrics();
  return registry.metrics();
}

export function getPrometheusContentType() {
  return registry.contentType;
}
