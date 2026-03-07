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
import { getTranscodeWorkerState } from "./transcodeWorker.js";
import { getOutboundProxyRuntimeStatus } from "./outbound.js";
import { getSmbRuntimeState } from "../smb/fuse.js";

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
  restoreJobsStarted: new client.Gauge({
    name: "offload_restore_jobs_started_total",
    help: "Total restore jobs started since process start",
    registers: [registry]
  }),
  restoreJobsDone: new client.Gauge({
    name: "offload_restore_jobs_done_total",
    help: "Total restore jobs done since process start",
    registers: [registry]
  }),
  restoreJobsError: new client.Gauge({
    name: "offload_restore_jobs_error_total",
    help: "Total restore jobs failed since process start",
    registers: [registry]
  }),
  restoreRate: new client.Gauge({
    name: "offload_restore_rate_bytes_per_second",
    help: "Restore throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  restoreAvgMs: new client.Gauge({
    name: "offload_restore_job_avg_ms",
    help: "Average restore job duration in ms",
    registers: [registry]
  }),
  previewStarted: new client.Gauge({
    name: "offload_preview_started_total",
    help: "Total previews started since process start",
    registers: [registry]
  }),
  previewDone: new client.Gauge({
    name: "offload_preview_done_total",
    help: "Total previews completed since process start",
    registers: [registry]
  }),
  previewError: new client.Gauge({
    name: "offload_preview_error_total",
    help: "Total previews failed since process start",
    registers: [registry]
  }),
  previewRate: new client.Gauge({
    name: "offload_preview_rate_bytes_per_second",
    help: "Preview throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  thumbnailJobsStarted: new client.Gauge({
    name: "offload_thumbnail_jobs_started_total",
    help: "Total thumbnail jobs started since process start",
    registers: [registry]
  }),
  thumbnailJobsDone: new client.Gauge({
    name: "offload_thumbnail_jobs_done_total",
    help: "Total thumbnail jobs done since process start",
    registers: [registry]
  }),
  thumbnailJobsError: new client.Gauge({
    name: "offload_thumbnail_jobs_error_total",
    help: "Total thumbnail jobs failed since process start",
    registers: [registry]
  }),
  thumbnailRate: new client.Gauge({
    name: "offload_thumbnail_rate_bytes_per_second",
    help: "Thumbnail output throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  thumbnailAvgMs: new client.Gauge({
    name: "offload_thumbnail_job_avg_ms",
    help: "Average thumbnail job duration in ms",
    registers: [registry]
  }),
  subtitleJobsStarted: new client.Gauge({
    name: "offload_subtitle_jobs_started_total",
    help: "Total subtitle jobs started since process start",
    registers: [registry]
  }),
  subtitleJobsDone: new client.Gauge({
    name: "offload_subtitle_jobs_done_total",
    help: "Total subtitle jobs done since process start",
    registers: [registry]
  }),
  subtitleJobsError: new client.Gauge({
    name: "offload_subtitle_jobs_error_total",
    help: "Total subtitle jobs failed since process start",
    registers: [registry]
  }),
  subtitleSourceBytes: new client.Gauge({
    name: "offload_subtitle_source_bytes_total",
    help: "Total subtitle source bytes processed since process start",
    registers: [registry]
  }),
  subtitleRate: new client.Gauge({
    name: "offload_subtitle_rate_bytes_per_second",
    help: "Subtitle output throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  subtitleAvgMs: new client.Gauge({
    name: "offload_subtitle_job_avg_ms",
    help: "Average subtitle job duration in ms",
    registers: [registry]
  }),
  subtitleProviderAttempted: new client.Gauge({
    name: "offload_subtitle_provider_attempted_total",
    help: "Subtitle provider attempts since process start",
    labelNames: ["provider"] as const,
    registers: [registry]
  }),
  subtitleProviderFailed: new client.Gauge({
    name: "offload_subtitle_provider_failed_total",
    help: "Subtitle provider failures since process start",
    labelNames: ["provider"] as const,
    registers: [registry]
  }),
  transcodeJobsStarted: new client.Gauge({
    name: "offload_transcode_jobs_started_total",
    help: "Total transcode jobs started since process start",
    registers: [registry]
  }),
  transcodeJobsDone: new client.Gauge({
    name: "offload_transcode_jobs_done_total",
    help: "Total transcode jobs done since process start",
    registers: [registry]
  }),
  transcodeJobsError: new client.Gauge({
    name: "offload_transcode_jobs_error_total",
    help: "Total transcode jobs failed since process start",
    registers: [registry]
  }),
  transcodeBytesIn: new client.Gauge({
    name: "offload_transcode_input_bytes_total",
    help: "Total source bytes passed to transcode jobs",
    registers: [registry]
  }),
  transcodeBytesOut: new client.Gauge({
    name: "offload_transcode_output_bytes_total",
    help: "Total output bytes generated by transcode jobs",
    registers: [registry]
  }),
  transcodeRate: new client.Gauge({
    name: "offload_transcode_rate_bytes_per_second",
    help: "Transcode output throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  transcodeAvgMs: new client.Gauge({
    name: "offload_transcode_job_avg_ms",
    help: "Average transcode job duration in ms",
    registers: [registry]
  }),
  deleteJobsStarted: new client.Gauge({
    name: "offload_delete_jobs_started_total",
    help: "Total delete jobs started since process start",
    registers: [registry]
  }),
  deleteJobsDone: new client.Gauge({
    name: "offload_delete_jobs_done_total",
    help: "Total delete jobs done since process start",
    registers: [registry]
  }),
  deleteJobsError: new client.Gauge({
    name: "offload_delete_jobs_error_total",
    help: "Total delete jobs failed since process start",
    registers: [registry]
  }),
  deletePartsDone: new client.Gauge({
    name: "offload_delete_parts_done_total",
    help: "Total deleted parts since process start",
    registers: [registry]
  }),
  deleteBytesFreed: new client.Gauge({
    name: "offload_delete_bytes_freed_total",
    help: "Total source bytes freed by delete jobs",
    registers: [registry]
  }),
  deleteRate: new client.Gauge({
    name: "offload_delete_rate_bytes_per_second",
    help: "Delete freed-bytes throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  deleteAvgMs: new client.Gauge({
    name: "offload_delete_job_avg_ms",
    help: "Average delete job duration in ms",
    registers: [registry]
  }),
  smbReadOpens: new client.Gauge({
    name: "offload_smb_read_opens_total",
    help: "Total SMB read opens since process start",
    registers: [registry]
  }),
  smbWriteOpens: new client.Gauge({
    name: "offload_smb_write_opens_total",
    help: "Total SMB write opens since process start",
    registers: [registry]
  }),
  smbReadOps: new client.Gauge({
    name: "offload_smb_read_ops_total",
    help: "Total SMB read operations since process start",
    registers: [registry]
  }),
  smbWriteOps: new client.Gauge({
    name: "offload_smb_write_ops_total",
    help: "Total SMB write operations since process start",
    registers: [registry]
  }),
  smbReadBytes: new client.Gauge({
    name: "offload_smb_read_bytes_total",
    help: "Total SMB read bytes since process start",
    registers: [registry]
  }),
  smbWriteBytes: new client.Gauge({
    name: "offload_smb_write_bytes_total",
    help: "Total SMB write bytes since process start",
    registers: [registry]
  }),
  smbReadRate: new client.Gauge({
    name: "offload_smb_read_rate_bytes_per_second",
    help: "SMB read throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  smbWriteRate: new client.Gauge({
    name: "offload_smb_write_rate_bytes_per_second",
    help: "SMB write throughput over last 60s in bytes/s",
    registers: [registry]
  }),
  smbErrors: new client.Gauge({
    name: "offload_smb_errors_total",
    help: "Total SMB operation errors since process start",
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
  archivesThumbPending: new client.Gauge({
    name: "offload_archives_thumbnail_pending_total",
    help: "Archives with files waiting for thumbnail generation",
    registers: [registry]
  }),
  archivesSubtitlePending: new client.Gauge({
    name: "offload_archives_subtitle_pending_total",
    help: "Archives with files waiting for subtitle generation",
    registers: [registry]
  }),
  archivesTranscodePending: new client.Gauge({
    name: "offload_archives_transcode_pending_total",
    help: "Primary archives with pending transcode copies",
    registers: [registry]
  }),
  transcodeArchivesTotal: new client.Gauge({
    name: "offload_transcode_archives_total",
    help: "Total active transcoded archives",
    registers: [registry]
  }),
  usersTotal: new client.Gauge({
    name: "offload_users_total",
    help: "Total users",
    registers: [registry]
  }),
  usersTranscodeEnabled: new client.Gauge({
    name: "offload_users_transcode_enabled_total",
    help: "Users with transcode copies enabled",
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
  transcodeWorkerState: new client.Gauge({
    name: "offload_transcode_worker_state",
    help: "Transcode worker state values",
    labelNames: ["state"] as const,
    registers: [registry]
  }),
  smbState: new client.Gauge({
    name: "offload_smb_state",
    help: "SMB runtime state values",
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
  const restore = (analytics as any).restore || {};
  const preview = (analytics as any).preview || {};
  const thumbnail = (analytics as any).thumbnail || {};
  const subtitle = (analytics as any).subtitle || {};
  const transcode = (analytics as any).transcode || {};
  const deletion = (analytics as any).deletion || {};
  const smb = (analytics as any).smb || {};

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
  gauges.restoreJobsStarted.set(restore.jobsStarted || 0);
  gauges.restoreJobsDone.set(restore.jobsDone || 0);
  gauges.restoreJobsError.set(restore.jobsError || 0);
  gauges.restoreRate.set(restore.rateBps60s || 0);
  gauges.restoreAvgMs.set(restore.avgJobMs || 0);
  gauges.previewStarted.set(preview.started || 0);
  gauges.previewDone.set(preview.done || 0);
  gauges.previewError.set(preview.error || 0);
  gauges.previewRate.set(preview.rateBps60s || 0);
  gauges.thumbnailJobsStarted.set(thumbnail.jobsStarted || 0);
  gauges.thumbnailJobsDone.set(thumbnail.jobsDone || 0);
  gauges.thumbnailJobsError.set(thumbnail.jobsError || 0);
  gauges.thumbnailRate.set(thumbnail.rateBps60s || 0);
  gauges.thumbnailAvgMs.set(thumbnail.avgJobMs || 0);
  gauges.subtitleJobsStarted.set(subtitle.jobsStarted || 0);
  gauges.subtitleJobsDone.set(subtitle.jobsDone || 0);
  gauges.subtitleJobsError.set(subtitle.jobsError || 0);
  gauges.subtitleSourceBytes.set(subtitle.sourceBytes || 0);
  gauges.subtitleRate.set(subtitle.rateBps60s || 0);
  gauges.subtitleAvgMs.set(subtitle.avgJobMs || 0);
  gauges.subtitleProviderAttempted.labels("asr").set(subtitle.providers?.asr?.attempted || 0);
  gauges.subtitleProviderAttempted.labels("local").set(subtitle.providers?.local?.attempted || 0);
  gauges.subtitleProviderFailed.labels("asr").set(subtitle.providers?.asr?.failed || 0);
  gauges.subtitleProviderFailed.labels("local").set(subtitle.providers?.local?.failed || 0);
  gauges.transcodeJobsStarted.set(transcode.jobsStarted || 0);
  gauges.transcodeJobsDone.set(transcode.jobsDone || 0);
  gauges.transcodeJobsError.set(transcode.jobsError || 0);
  gauges.transcodeBytesIn.set(transcode.bytesIn || 0);
  gauges.transcodeBytesOut.set(transcode.bytesOut || 0);
  gauges.transcodeRate.set(transcode.rateBps60s || 0);
  gauges.transcodeAvgMs.set(transcode.avgJobMs || 0);
  gauges.deleteJobsStarted.set(deletion.jobsStarted || 0);
  gauges.deleteJobsDone.set(deletion.jobsDone || 0);
  gauges.deleteJobsError.set(deletion.jobsError || 0);
  gauges.deletePartsDone.set(deletion.partsDone || 0);
  gauges.deleteBytesFreed.set(deletion.bytesFreed || 0);
  gauges.deleteRate.set(deletion.rateBps60s || 0);
  gauges.deleteAvgMs.set(deletion.avgJobMs || 0);
  gauges.smbReadOpens.set(smb.readOpens || 0);
  gauges.smbWriteOpens.set(smb.writeOpens || 0);
  gauges.smbReadOps.set(smb.readOps || 0);
  gauges.smbWriteOps.set(smb.writeOps || 0);
  gauges.smbReadBytes.set(smb.readBytes || 0);
  gauges.smbWriteBytes.set(smb.writeBytes || 0);
  gauges.smbReadRate.set(smb.readRateBps60s || 0);
  gauges.smbWriteRate.set(smb.writeRateBps60s || 0);
  gauges.smbErrors.set(smb.errors || 0);

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

  const transcodeState = getTranscodeWorkerState();
  gauges.transcodeWorkerState.labels("enabled").set(transcodeState.enabled ? 1 : 0);
  gauges.transcodeWorkerState.labels("queued").set(transcodeState.queued || 0);
  gauges.transcodeWorkerState.labels("active").set(transcodeState.active || 0);
  gauges.transcodeWorkerState.labels("retry_scheduled").set(transcodeState.retryScheduled || 0);
  gauges.transcodeWorkerState.labels("tick_running").set(transcodeState.tickRunning ? 1 : 0);

  const smbState = getSmbRuntimeState();
  gauges.smbState.labels("dir_cache_entries").set(smbState.dirCacheEntries || 0);
  gauges.smbState.labels("user_cache_entries").set(smbState.userCacheEntries || 0);
  gauges.smbState.labels("read_cache_entries").set(smbState.readCacheEntries || 0);
  gauges.smbState.labels("progressive_read_entries").set(smbState.progressiveReadEntries || 0);
  gauges.smbState.labels("active_handles").set(smbState.activeHandles || 0);

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
      archivesThumbPending,
      archivesSubtitlePending,
      archivesTranscodePending,
      transcodeArchivesTotal,
      usersTotal,
      usersTranscodeEnabled,
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
      Archive.countDocuments({
        deletedAt: null,
        trashedAt: null,
        "files.0": { $exists: true },
        files: {
          $elemMatch: {
            $and: [
              { $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] },
              { "thumbnail.updatedAt": { $exists: false } }
            ]
          }
        }
      }),
      Archive.countDocuments({
        deletedAt: null,
        trashedAt: null,
        "files.0": { $exists: true },
        files: {
          $elemMatch: {
            $and: [
              { $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] },
              { "subtitle.updatedAt": { $exists: false } }
            ]
          }
        }
      }),
      Archive.countDocuments({
        deletedAt: null,
        trashedAt: null,
        archiveKind: "primary",
        status: "ready",
        files: {
          $elemMatch: {
            $and: [
              { $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] },
              {
                $or: [
                  { "transcode.status": { $exists: false } },
                  { "transcode.status": { $in: ["error", ""] } },
                  { "transcode.status": "skipped", "transcode.error": "disabled_by_user" },
                  { "transcode.archiveId": { $exists: false } },
                  { "transcode.archiveId": "" }
                ]
              }
            ]
          }
        }
      }),
      Archive.countDocuments({ deletedAt: null, archiveKind: "transcoded" }),
      User.countDocuments({}),
      User.countDocuments({ transcodeCopiesEnabled: true }),
      Webhook.countDocuments({ enabled: true })
    ]);

    gauges.archivesTotal.set(archivesTotal || 0);
    gauges.archivesDeleteRequested.set(archivesDeleteRequested || 0);
    gauges.archivesTrashed.set(archivesTrashed || 0);
    gauges.archivesMirrorPending.set(archivesMirrorPending || 0);
    gauges.archivesThumbPending.set(archivesThumbPending || 0);
    gauges.archivesSubtitlePending.set(archivesSubtitlePending || 0);
    gauges.archivesTranscodePending.set(archivesTranscodePending || 0);
    gauges.transcodeArchivesTotal.set(transcodeArchivesTotal || 0);
    gauges.usersTotal.set(usersTotal || 0);
    gauges.usersTranscodeEnabled.set(usersTranscodeEnabled || 0);
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
