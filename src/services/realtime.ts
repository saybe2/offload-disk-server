import type { RequestHandler } from "express";
import { ServerResponse, type IncomingMessage, type Server as HttpServer } from "http";
import type { Duplex } from "stream";
import { Archive } from "../models/Archive.js";
import { log } from "../logger.js";
import { isPreviewSupportedForFile } from "./mediaPreviewSupport.js";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

interface SessionDataLike {
  userId?: string;
  role?: "admin" | "user";
}

interface SessionRequest extends IncomingMessage {
  session?: SessionDataLike;
}

type ArchiveView = "files" | "trash";

interface ArchiveSubscription {
  queryKey: string;
  view: ArchiveView;
  folderId: string | null;
  ownerId: string | null;
  rootOnly: boolean;
  query: string;
  limit: number;
  sortField: "name" | "date" | "size" | "views" | "downloads" | "type";
  sortDir: "asc" | "desc";
  lastById: Map<string, string>;
  lastOrder: string[];
  lastTotal: number;
  lastHasMore: boolean;
}

interface RealtimeClient {
  ws: WebSocket;
  userId: string;
  role: "admin" | "user";
  archivesSub: ArchiveSubscription | null;
}

interface ArchivePatchMessage {
  type: "archives_patch";
  queryKey: string;
  total: number;
  hasMore: boolean;
  orderedIds: string[];
  upserts: any[];
  removedIds: string[];
}

const WS_PATH = "/ws";
const WS_SYNC_INTERVAL_MS = 3000;
const MIN_LIMIT = 40;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 120;
const ARCHIVE_LIST_PROJECTION = {
  _id: 1,
  folderId: 1,
  status: 1,
  isBundle: 1,
  priority: 1,
  deleting: 1,
  deleteRequestedAt: 1,
  deletedParts: 1,
  deleteTotalParts: 1,
  uploadedParts: 1,
  totalParts: 1,
  originalSize: 1,
  encryptedSize: 1,
  contentModifiedAt: 1,
  createdAt: 1,
  displayName: 1,
  name: 1,
  "files.name": 1,
  "files.originalName": 1,
  "files.size": 1,
  "files.contentModifiedAt": 1,
  "files.downloadCount": 1,
  "files.previewCount": 1,
  "files.detectedKind": 1,
  "files.detectedTypeLabel": 1,
  "files.deletedAt": 1,
  "files.transcode.status": 1,
  "files.transcode.archiveId": 1
} as const;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeObjectId(value: unknown): string | null {
  const raw = normalizeString(value);
  if (!raw) return null;
  return /^[a-fA-F0-9]{24}$/.test(raw) ? raw : null;
}

function withPreviewSupport(archive: any) {
  const files = Array.isArray(archive?.files)
    ? archive.files.map((file: any) => ({
        ...file,
        previewSupported: isPreviewSupportedForFile(archive, file)
      }))
    : [];
  return { ...archive, files };
}

function getRequestPath(request: IncomingMessage) {
  const host = request.headers.host || "localhost";
  const url = request.url || "/";
  try {
    return new URL(url, `http://${host}`).pathname;
  } catch {
    return "/";
  }
}

function parseMessage(raw: RawData) {
  try {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeLimit(value: unknown) {
  const num = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(Math.max(num, MIN_LIMIT), MAX_LIMIT);
}

function normalizeSortField(value: unknown): ArchiveSubscription["sortField"] {
  const raw = normalizeString(value).toLowerCase();
  if (
    raw === "name" ||
    raw === "date" ||
    raw === "size" ||
    raw === "views" ||
    raw === "downloads" ||
    raw === "type"
  ) {
    return raw;
  }
  return "name";
}

function normalizeSortDir(value: unknown): ArchiveSubscription["sortDir"] {
  return normalizeString(value).toLowerCase() === "desc" ? "desc" : "asc";
}

function buildArchiveSort(
  sortField: ArchiveSubscription["sortField"],
  sortDir: ArchiveSubscription["sortDir"]
) {
  const dir: 1 | -1 = sortDir === "desc" ? -1 : 1;
  const fallbackCreatedAt: 1 | -1 = dir;
  const fallbackId: 1 | -1 = dir;
  if (sortField === "date") {
    return { contentModifiedAt: dir, createdAt: dir, _id: fallbackId } as Record<string, 1 | -1>;
  }
  if (sortField === "size") {
    return { originalSize: dir, createdAt: fallbackCreatedAt, _id: fallbackId } as Record<string, 1 | -1>;
  }
  if (sortField === "views") {
    return { "files.0.previewCount": dir, createdAt: fallbackCreatedAt, _id: fallbackId } as Record<string, 1 | -1>;
  }
  if (sortField === "downloads") {
    return { "files.0.downloadCount": dir, createdAt: fallbackCreatedAt, _id: fallbackId } as Record<string, 1 | -1>;
  }
  if (sortField === "type") {
    return {
      "files.0.detectedTypeLabel": dir,
      "files.0.detectedKind": dir,
      displayName: dir,
      _id: fallbackId
    } as Record<string, 1 | -1>;
  }
  return { displayName: dir, createdAt: fallbackCreatedAt, _id: fallbackId } as Record<string, 1 | -1>;
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(payload));
}

function serializeArchive(archive: any) {
  return JSON.stringify(archive);
}

async function fetchArchiveWindow(client: RealtimeClient, sub: ArchiveSubscription) {
  const isTrash = sub.view === "trash";
  const baseFilter =
    client.role === "admin"
      ? { userId: sub.ownerId || client.userId }
      : { userId: client.userId };
  const filter: Record<string, unknown> = {
    ...baseFilter,
    archiveKind: { $ne: "transcoded" },
    deletedAt: null,
    trashedAt: isTrash ? { $ne: null } : null
  };

  if (!isTrash) {
    filter.trashedAt = null;
  }

  if (sub.folderId) {
    filter.folderId = sub.folderId;
  } else if (sub.rootOnly && !isTrash) {
    filter.folderId = null;
  }

  if (sub.query) {
    const needle = new RegExp(escapeRegex(sub.query), "i");
    filter.$or = [
      { displayName: needle },
      { name: needle },
      { "files.originalName": needle },
      { "files.name": needle }
    ];
  }

  const total = await Archive.countDocuments(filter);
  const sort = buildArchiveSort(sub.sortField, sub.sortDir);
  const archives = await Archive.find(filter)
    .select(ARCHIVE_LIST_PROJECTION)
    .sort(sort)
    .limit(sub.limit)
    .lean();
  const hasMore = archives.length < total;

  return {
    total,
    hasMore,
    archives: archives.map((archive) => withPreviewSupport(archive))
  };
}

function shouldPushPatch(
  sub: ArchiveSubscription,
  nextOrder: string[],
  nextTotal: number,
  nextHasMore: boolean,
  upsertsCount: number,
  removedCount: number,
  force: boolean
) {
  if (force) return true;
  if (upsertsCount > 0 || removedCount > 0) return true;
  if (sub.lastTotal !== nextTotal || sub.lastHasMore !== nextHasMore) return true;
  if (sub.lastOrder.length !== nextOrder.length) return true;
  for (let i = 0; i < nextOrder.length; i += 1) {
    if (sub.lastOrder[i] !== nextOrder[i]) {
      return true;
    }
  }
  return false;
}

async function pushArchivePatch(client: RealtimeClient, force = false) {
  const sub = client.archivesSub;
  if (!sub) return;

  const snapshot = await fetchArchiveWindow(client, sub);
  const nextById = new Map<string, string>();
  const orderedIds: string[] = [];
  const upserts: any[] = [];

  for (const archive of snapshot.archives) {
    const id = String(archive?._id || "");
    if (!id) continue;
    orderedIds.push(id);
    const serialized = serializeArchive(archive);
    nextById.set(id, serialized);
    if (force || sub.lastById.get(id) !== serialized) {
      upserts.push(archive);
    }
  }

  const removedIds: string[] = [];
  for (const prevId of sub.lastById.keys()) {
    if (!nextById.has(prevId)) {
      removedIds.push(prevId);
    }
  }

  if (
    !shouldPushPatch(
      sub,
      orderedIds,
      snapshot.total,
      snapshot.hasMore,
      upserts.length,
      removedIds.length,
      force
    )
  ) {
    return;
  }

  sub.lastById = nextById;
  sub.lastOrder = orderedIds;
  sub.lastTotal = snapshot.total;
  sub.lastHasMore = snapshot.hasMore;

  const message: ArchivePatchMessage = {
    type: "archives_patch",
    queryKey: sub.queryKey,
    total: snapshot.total,
    hasMore: snapshot.hasMore,
    orderedIds,
    upserts,
    removedIds
  };

  sendJson(client.ws, message);
}

function parseArchiveSubscription(message: Record<string, unknown>): ArchiveSubscription | null {
  const view = message.view === "trash" ? "trash" : message.view === "files" ? "files" : null;
  if (!view) return null;

  const queryKey = normalizeString(message.queryKey);
  if (!queryKey) return null;

  const folderIdRaw = normalizeString(message.folderId);
  const ownerId = normalizeObjectId(message.ownerId);
  const query = normalizeString(message.query);

  return {
    queryKey,
    view,
    folderId: folderIdRaw || null,
    ownerId,
    rootOnly: message.rootOnly === true,
    query,
    limit: normalizeLimit(message.limit),
    sortField: normalizeSortField(message.sort),
    sortDir: normalizeSortDir(message.dir),
    lastById: new Map(),
    lastOrder: [],
    lastTotal: -1,
    lastHasMore: false
  };
}

function closeUnauthorized(socket: Duplex) {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

export function initRealtimeServer(server: HttpServer, sessionMiddleware: RequestHandler) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, RealtimeClient>();
  let pollInFlight = false;

  const tick = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const targets = Array.from(clients.values()).filter((client) => client.archivesSub);
      for (const client of targets) {
        try {
          await pushArchivePatch(client);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log("realtime", `archives sync failed user=${client.userId} err=${message}`);
        }
      }
    } finally {
      pollInFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, WS_SYNC_INTERVAL_MS);

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    const req = request as SessionRequest;
    const userId = req.session?.userId;
    if (!userId) {
      ws.close(1008, "auth_required");
      return;
    }

    const client: RealtimeClient = {
      ws,
      userId,
      role: req.session?.role === "admin" ? "admin" : "user",
      archivesSub: null
    };

    clients.set(ws, client);
    sendJson(ws, { type: "realtime_ready" });

    ws.on("message", (raw: RawData) => {
      const message = parseMessage(raw);
      if (!message || typeof message.type !== "string") return;

      if (message.type === "subscribe_archives") {
        const sub = parseArchiveSubscription(message);
        if (!sub) return;
        client.archivesSub = sub;
        void pushArchivePatch(client, true);
        return;
      }

      if (message.type === "unsubscribe_archives") {
        client.archivesSub = null;
        return;
      }

      if (message.type === "ping") {
        sendJson(ws, { type: "pong" });
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    if (getRequestPath(request) !== WS_PATH) {
      socket.destroy();
      return;
    }

    const fakeRes = new ServerResponse(request);
    sessionMiddleware(request as any, fakeRes as any, () => {
      const req = request as SessionRequest;
      if (!req.session?.userId) {
        closeUnauthorized(socket);
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit("connection", ws, request);
      });
    });
  });

  server.on("close", () => {
    clearInterval(timer);
    for (const ws of clients.keys()) {
      ws.close();
    }
    clients.clear();
  });

  log("realtime", `enabled path=${WS_PATH} sync=${WS_SYNC_INTERVAL_MS}ms`);
}
