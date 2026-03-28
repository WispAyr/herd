/**
 * SentryFlow integration — optional external event forwarding.
 * Enabled when SENTRYFLOW_URL env var is set.
 *
 * Sends crowd count snapshots every 30s and alert events on threshold breach.
 */

import { db } from './db';

const SENTRYFLOW_URL = process.env.SENTRYFLOW_URL || '';
const SEND_INTERVAL_MS = 30000; // 30 seconds

let intervalHandle: ReturnType<typeof setInterval> | null = null;

function isEnabled(): boolean {
  return SENTRYFLOW_URL.trim().length > 0;
}

async function postEvent(payload: object): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(`${SENTRYFLOW_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (err: any) {
    // Non-blocking — log but don't affect main loop
    console.warn(`[sentryflow] POST failed: ${err.message}`);
  }
}

async function sendCrowdSnapshot(): Promise<void> {
  if (!isEnabled()) return;

  try {
    const zones = db.prepare(`
      SELECT z.id, z.name, z.capacity,
        COALESCE((SELECT count FROM counts WHERE zone_id = z.id ORDER BY timestamp DESC LIMIT 1), 0) as count
      FROM zones z WHERE z.active = 1
    `).all() as any[];

    const total = zones.reduce((s: number, z: any) => s + (z.count || 0), 0);

    await postEvent({
      type: 'crowd_count',
      zones: zones.map(z => ({
        id: z.id,
        name: z.name,
        count: z.count,
        capacity: z.capacity,
        pct: z.capacity > 0 ? Math.round((z.count / z.capacity) * 100) : 0
      })),
      total,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.warn(`[sentryflow] Snapshot error: ${err.message}`);
  }
}

/**
 * Forward an alert event to SentryFlow.
 * Called from camera.ts when a zone hits warning/critical.
 */
export async function forwardAlert(zoneId: string, zoneName: string, level: string, count: number, capacity: number): Promise<void> {
  if (!isEnabled()) return;

  postEvent({
    type: 'alert',
    zone_id: zoneId,
    zone_name: zoneName,
    level,
    count,
    capacity,
    pct: capacity > 0 ? Math.round((count / capacity) * 100) : 0,
    timestamp: new Date().toISOString()
  }).catch(() => {}); // non-blocking
}

export function startSentryFlow(): void {
  if (!isEnabled()) {
    console.log('[sentryflow] SENTRYFLOW_URL not set — integration disabled');
    return;
  }

  console.log(`[sentryflow] Enabled — posting to ${SENTRYFLOW_URL} every ${SEND_INTERVAL_MS / 1000}s`);
  intervalHandle = setInterval(sendCrowdSnapshot, SEND_INTERVAL_MS);
  // Send initial snapshot after 5s (allow cameras to get first frames)
  setTimeout(sendCrowdSnapshot, 5000);
}

export function stopSentryFlow(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
