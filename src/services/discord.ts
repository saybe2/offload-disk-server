import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { fetch, FormData, File } from "undici";
import { config } from "../config.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(text: string, headerValue: string | null) {
  let delayMs = 0;
  if (headerValue) {
    const n = Number(headerValue);
    if (Number.isFinite(n) && n > 0) {
      delayMs = Math.max(delayMs, n > 1000 ? n : n * 1000);
    }
  }
  if (text) {
    try {
      const data = JSON.parse(text) as { retry_after?: number };
      const retryAfter = Number(data.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delayMs = Math.max(delayMs, retryAfter > 1000 ? retryAfter : retryAfter * 1000);
      }
    } catch {
      // ignore non-json body
    }
  }
  return delayMs;
}

function shouldRetryStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function withDiscordRetry<T>(
  label: string,
  operation: () => Promise<T>
) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      attempt += 1;
      const message = err instanceof Error ? err.message : String(err);
      const transient =
        /fetch failed/i.test(message) ||
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message) ||
        /(download|webhook_(upload|message|delete)_failed):(429|5\d\d)/.test(message);
      if (!transient || attempt > config.uploadRetryMax) {
        throw err;
      }
      const delay = Math.min(config.uploadRetryMaxMs, config.uploadRetryBaseMs * Math.pow(2, attempt - 1));
      await sleep(delay);
      console.log(`[discord] ${new Date().toISOString()} retry ${label} attempt=${attempt} delay=${delay}ms`);
    }
  }
}

export async function uploadToWebhook(filePath: string, webhookUrl: string, content: string) {
  return withDiscordRetry("upload", async () => {
    const form = new FormData();
    const buffer = await fs.promises.readFile(filePath);
    const file = new File([buffer], path.basename(filePath));
    form.append("content", content);
    form.append("file", file);

    const res = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      body: form
    });

    if (!res.ok) {
      const text = await res.text();
      if (shouldRetryStatus(res.status)) {
        const retryDelay = parseRetryAfterMs(text, res.headers.get("retry-after"));
        if (retryDelay > 0) {
          await sleep(retryDelay);
        }
      }
      throw new Error(`webhook_upload_failed:${res.status}:${text}`);
    }

    const data = (await res.json()) as { attachments?: { url: string; id: string }[]; id?: string };
    const attachment = data.attachments?.[0];
    if (!attachment || !data.id) {
      throw new Error("webhook_missing_attachment");
    }

    return { url: attachment.url, messageId: data.id };
  });
}

export async function uploadBufferToWebhook(buffer: Buffer, filename: string, webhookUrl: string, content: string) {
  return withDiscordRetry("upload", async () => {
    const form = new FormData();
    const file = new File([buffer], filename);
    form.append("content", content);
    form.append("file", file);

    const res = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      body: form
    });

    if (!res.ok) {
      const text = await res.text();
      if (shouldRetryStatus(res.status)) {
        const retryDelay = parseRetryAfterMs(text, res.headers.get("retry-after"));
        if (retryDelay > 0) {
          await sleep(retryDelay);
        }
      }
      throw new Error(`webhook_upload_failed:${res.status}:${text}`);
    }

    const data = (await res.json()) as { attachments?: { url: string; id: string }[]; id?: string };
    const attachment = data.attachments?.[0];
    if (!attachment || !data.id) {
      throw new Error("webhook_missing_attachment");
    }

    return { url: attachment.url, messageId: data.id };
  });
}

export async function downloadToFile(url: string, destPath: string) {
  await withDiscordRetry("download", async () => {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      const text = await res.text();
      if (shouldRetryStatus(res.status)) {
        const retryDelay = parseRetryAfterMs(text, res.headers.get("retry-after"));
        if (retryDelay > 0) {
          await sleep(retryDelay);
        }
      }
      throw new Error(`download_failed:${res.status}:${text}`);
    }
    await pipeline(res.body, fs.createWriteStream(destPath));
  });
}

export async function deleteWebhookMessage(webhookUrl: string, messageId: string) {
  await withDiscordRetry("delete", async () => {
    const url = `${webhookUrl}/messages/${messageId}`;
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const text = await res.text();
      if (shouldRetryStatus(res.status)) {
        const retryDelay = parseRetryAfterMs(text, res.headers.get("retry-after"));
        if (retryDelay > 0) {
          await sleep(retryDelay);
        }
      }
      throw new Error(`webhook_delete_failed:${res.status}:${text}`);
    }
  });
}

export async function fetchWebhookMessage(webhookUrl: string, messageId: string) {
  return withDiscordRetry("fetch_message", async () => {
    const url = `${webhookUrl}/messages/${messageId}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      if (shouldRetryStatus(res.status)) {
        const retryDelay = parseRetryAfterMs(text, res.headers.get("retry-after"));
        if (retryDelay > 0) {
          await sleep(retryDelay);
        }
      }
      throw new Error(`webhook_message_failed:${res.status}:${text}`);
    }
    return res.json() as Promise<{ attachments?: { url: string }[] }>;
  });
}
