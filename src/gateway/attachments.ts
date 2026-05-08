/**
 * gateway/attachments.ts — Incoming file storage for chat attachments
 *
 * Saves voice messages, images, files, and videos to disk.
 * Each message gets its own directory under ~/.roundhouse/incoming/.
 */

import { join, basename } from "node:path";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { ROUNDHOUSE_DIR } from "../config";
import { threadIdToDir, generateAttachmentId } from "../util";
import type { MessageAttachment } from "../types";

// ── Constants ────────────────────────────────────────

const INCOMING_DIR = process.env.ROUNDHOUSE_INCOMING_DIR
  ?? join(ROUNDHOUSE_DIR, "incoming");

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB per file
export const MAX_ATTACHMENTS = 5;

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
};

const VALID_MEDIA_TYPES = new Set(["audio", "image", "file", "video"]);

// ── Types ────────────────────────────────────────────

export interface AttachmentResult {
  saved: MessageAttachment[];
  skipped: string[];
}

// ── Helpers ──────────────────────────────────────────

/** Sanitize a filename to safe ASCII characters, capped length */
function safeName(raw: string): string {
  let name = basename(raw);
  name = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (name.length > 100) name = name.slice(-100);
  name = name.replace(/^[-_.]+/, "");
  return name || "attachment";
}

// ── Main Function ────────────────────────────────────

/**
 * Save incoming attachments to disk.
 * Returns saved file metadata and user-facing skip reasons.
 */
export async function saveAttachments(threadId: string, attachments: any[]): Promise<AttachmentResult> {
  if (!attachments?.length) return { saved: [], skipped: [] };

  const skipped: string[] = [];
  const toProcess = attachments.slice(0, MAX_ATTACHMENTS);
  if (attachments.length > MAX_ATTACHMENTS) {
    skipped.push(`${attachments.length - MAX_ATTACHMENTS} attachment(s) skipped (max ${MAX_ATTACHMENTS} per message)`);
    console.warn(`[roundhouse] too many attachments (${attachments.length}), processing first ${MAX_ATTACHMENTS}`);
  }

  const msgDir = join(INCOMING_DIR, threadIdToDir(threadId), `${Date.now()}_${generateAttachmentId()}`);
  try {
    mkdirSync(msgDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.error(`[roundhouse] failed to create incoming dir ${msgDir}:`, (err as Error).message);
    return { saved: [], skipped: ["Failed to create storage directory"] };
  }

  const saved: MessageAttachment[] = [];
  for (let i = 0; i < toProcess.length; i++) {
    const att = toProcess[i];
    try {
      if (att.size && att.size > MAX_FILE_SIZE) {
        const sizeMB = (att.size / 1024 / 1024).toFixed(1);
        skipped.push(`${att.name ?? att.type} (${sizeMB} MB) exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`);
        continue;
      }

      const data = att.data ?? (att.fetchData ? await att.fetchData() : null);
      if (!data) {
        console.warn(`[roundhouse] attachment has no data: ${att.name ?? att.type}`);
        continue;
      }

      let buf: Buffer;
      if (Buffer.isBuffer(data)) {
        buf = data;
      } else if (data instanceof Blob) {
        if (data.size > MAX_FILE_SIZE) {
          skipped.push(`${att.name ?? att.type} (${(data.size / 1024 / 1024).toFixed(1)} MB) exceeds size limit`);
          continue;
        }
        buf = Buffer.from(await data.arrayBuffer());
      } else if (ArrayBuffer.isView(data)) {
        buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else if (data instanceof ArrayBuffer) {
        buf = Buffer.from(data);
      } else {
        console.warn(`[roundhouse] unknown attachment data type, skipping: ${att.name ?? att.type}`);
        continue;
      }

      if (buf.length > MAX_FILE_SIZE) {
        skipped.push(`${att.name ?? att.type} (${(buf.length / 1024 / 1024).toFixed(1)} MB) exceeds size limit`);
        continue;
      }

      const mime = att.mimeType ?? "application/octet-stream";
      const ext = att.name
        ? (att.name.includes(".") ? "" : (MIME_EXTENSIONS[mime] ?? ""))
        : (MIME_EXTENSIONS[mime] ?? ".bin");
      const rawName = att.name ? safeName(att.name) + ext : `${att.type ?? "file"}${ext}`;
      const fileName = `${i}-${rawName}`;
      const filePath = join(msgDir, fileName);

      await writeFile(filePath, buf, { mode: 0o600 });

      const mediaType = VALID_MEDIA_TYPES.has(att.type) ? att.type : "file";
      const id = generateAttachmentId();
      saved.push({
        id,
        mediaType,
        name: rawName,
        localPath: filePath,
        mime,
        sizeBytes: buf.length,
        untrusted: true,
      });
      console.log(`[roundhouse] saved ${att.type} [${id}]: ${filePath} (${buf.length} bytes)`);
    } catch (err) {
      console.error(`[roundhouse] failed to save attachment:`, (err as Error).message);
    }
  }
  return { saved, skipped };
}
