import { File, FormData } from "undici";
import { config } from "../config.js";
import { outboundFetch } from "./outbound.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function telegramApiUrl(method: string) {
  return `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
}

function telegramFileUrl(filePath: string) {
  return `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
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
      const data = JSON.parse(text) as { parameters?: { retry_after?: number } };
      const retryAfter = Number(data.parameters?.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delayMs = Math.max(delayMs, retryAfter > 1000 ? retryAfter : retryAfter * 1000);
      }
    } catch {
      // ignore parse error
    }
  }
  return delayMs;
}

function shouldRetryStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isTransientError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed/i.test(message)) return true;
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message)) return true;
  const match = message.match(/telegram_(upload|get_file|delete)_failed:(\d{3})/);
  if (!match) return false;
  const code = Number(match[1]);
  return code === 429 || (code >= 500 && code <= 599);
}

async function withTelegramRetry<T>(label: string, operation: () => Promise<T>) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      attempt += 1;
      if (!isTransientError(err) || attempt > config.uploadRetryMax) {
        throw err;
      }
      const delay = Math.min(config.uploadRetryMaxMs, config.uploadRetryBaseMs * Math.pow(2, attempt - 1));
      await sleep(delay);
      console.log(`[telegram] ${new Date().toISOString()} retry ${label} attempt=${attempt} delay=${delay}ms`);
    }
  }
}

function requireTelegramConfig() {
  if (!config.telegramEnabled) {
    throw new Error("telegram_disabled");
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new Error("telegram_not_configured");
  }
}

export function isTelegramReady() {
  return config.telegramEnabled && !!config.telegramBotToken && !!config.telegramChatId;
}

export async function uploadBufferToTelegram(
  buffer: Buffer,
  filename: string,
  caption: string
) {
  requireTelegramConfig();
  return withTelegramRetry("upload", async () => {
    const form = new FormData();
    const file = new File([buffer], filename);
    form.append("chat_id", config.telegramChatId);
    form.append("caption", caption.slice(0, 1024));
    form.append("document", file);

    const res = await outboundFetch(telegramApiUrl("sendDocument"), {
      method: "POST",
      body: form
    });
    const text = await res.text();
    if (!res.ok) {
      if (shouldRetryStatus(res.status)) {
        const retryDelay = parseRetryAfterMs(text, res.headers.get("retry-after"));
        if (retryDelay > 0) await sleep(retryDelay);
      }
      throw new Error(`telegram_upload_failed:${res.status}:${text}`);
    }
    const data = JSON.parse(text) as {
      ok?: boolean;
      result?: { message_id?: number; document?: { file_id?: string; file_unique_id?: string } };
      description?: string;
    };
    if (!data.ok || !data.result?.message_id || !data.result?.document?.file_id) {
      throw new Error(`telegram_upload_bad_response:${data.description || "missing_fields"}`);
    }
    const filePath = await getTelegramFilePath(data.result.document.file_id);
    return {
      url: telegramFileUrl(filePath),
      messageId: String(data.result.message_id),
      fileId: data.result.document.file_id,
      chatId: config.telegramChatId
    };
  });
}

export async function getTelegramFilePath(fileId: string) {
  requireTelegramConfig();
  return withTelegramRetry("get_file", async () => {
    const res = await outboundFetch(telegramApiUrl(`getFile?file_id=${encodeURIComponent(fileId)}`));
    const text = await res.text();
    if (!res.ok) {
      if (shouldRetryStatus(res.status)) {
        const retryDelay = parseRetryAfterMs(text, res.headers.get("retry-after"));
        if (retryDelay > 0) await sleep(retryDelay);
      }
      throw new Error(`telegram_get_file_failed:${res.status}:${text}`);
    }
    const data = JSON.parse(text) as { ok?: boolean; result?: { file_path?: string }; description?: string };
    if (!data.ok || !data.result?.file_path) {
      throw new Error(`telegram_get_file_bad_response:${data.description || "missing_file_path"}`);
    }
    return data.result.file_path;
  });
}

export async function buildTelegramFileUrl(fileId: string) {
  const filePath = await getTelegramFilePath(fileId);
  return telegramFileUrl(filePath);
}

export async function deleteTelegramMessage(chatId: string, messageId: string) {
  requireTelegramConfig();
  return withTelegramRetry("delete", async () => {
    const payload = { chat_id: chatId, message_id: Number(messageId) };
    const res = await outboundFetch(telegramApiUrl("deleteMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (!res.ok) {
      if (shouldRetryStatus(res.status)) {
        const retryDelay = parseRetryAfterMs(text, res.headers.get("retry-after"));
        if (retryDelay > 0) await sleep(retryDelay);
      }
      throw new Error(`telegram_delete_failed:${res.status}:${text}`);
    }
  });
}

