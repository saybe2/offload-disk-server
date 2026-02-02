import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { fetch, FormData, File } from "undici";

export async function uploadToWebhook(filePath: string, webhookUrl: string, content: string) {
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
    throw new Error(`webhook_upload_failed:${res.status}:${text}`);
  }

  const data = (await res.json()) as { attachments?: { url: string; id: string }[]; id?: string };
  const attachment = data.attachments?.[0];
  if (!attachment || !data.id) {
    throw new Error("webhook_missing_attachment");
  }

  return { url: attachment.url, messageId: data.id };
}

export async function uploadBufferToWebhook(buffer: Buffer, filename: string, webhookUrl: string, content: string) {
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
    throw new Error(`webhook_upload_failed:${res.status}:${text}`);
  }

  const data = (await res.json()) as { attachments?: { url: string; id: string }[]; id?: string };
  const attachment = data.attachments?.[0];
  if (!attachment || !data.id) {
    throw new Error("webhook_missing_attachment");
  }

  return { url: attachment.url, messageId: data.id };
}

export async function downloadToFile(url: string, destPath: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`download_failed:${res.status}:${text}`);
  }
  await pipeline(res.body, fs.createWriteStream(destPath));
}

export async function deleteWebhookMessage(webhookUrl: string, messageId: string) {
  const url = `${webhookUrl}/messages/${messageId}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`webhook_delete_failed:${res.status}:${text}`);
  }
}
