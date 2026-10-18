/**
 * API client — the server's own state for an admin (GET /server/status, apps/api/src/routes/server-status.ts).
 *
 * Important: a 404 means a server older than 2.8.0 — the settings screen then shows nothing instead of an error.
 */
import { ApiError, withAuth } from './http.js';

export interface ServerStatus {
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  store: { kind: 'memory' | 'folder' | 'postgres'; ok: boolean; responseMs: number; error?: string };
  /** The disk this server writes to: its data folder ('data') or the folder it runs in ('server'); null when unreadable */
  disk: { of: 'data' | 'server'; path: string; freeBytes: number; totalBytes: number; freePercent: number } | null;
  /** Remote collector traffic of the last hour; null when the remote collector is off */
  edge: { batches: number; refused: number; samplesRejected: number; sinceStart: boolean } | null;
}

/** Undefined from a server without this route */
export async function serverStatus(): Promise<ServerStatus | undefined> {
  const response = await fetch('/server/status', withAuth());
  if (response.status === 404) return undefined;
  if (!response.ok) {
    let text: string | undefined;
    try {
      text = ((await response.json()) as { messages?: { text?: string }[] }).messages?.[0]?.text;
    } catch {
      /* Not JSON — a proxy in front */
    }
    throw new ApiError(response.status, text ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as ServerStatus;
}
