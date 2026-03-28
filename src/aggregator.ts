/**
 * Herd Aggregator — polls multiple remote Herd instances and merges their data
 * into a unified event-wide dataset.
 *
 * Config:
 *   HERD_SOURCES=http://172.6.192.75:3050,http://10.42.42.161:3051
 *   AGGREGATE_INTERVAL_MS=5000
 *   EVENT_NAME="Live Event"
 */

import { broadcast } from './ws';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SourceStatus {
  url: string;
  label: string;
  online: boolean;
  lastSeen: number | null;
  error?: string;
}

export interface AggregatedZone {
  id: string;
  name: string;
  capacity: number;
  count: number;
  pct: number;
  alert_level: string | null;
  camera_id: string;
  source_url: string;
  source_label: string;
  trend?: 'up' | 'down' | 'stable';
}

export interface AggregatedFlow {
  zone_id: string;
  zone_name: string;
  direction_x: number;
  direction_y: number;
  magnitude: number;
  dominant_label: string;
  source_url: string;
  source_label: string;
}

export interface AggregatedAlert {
  id: string;
  zone_id: string;
  zone_name: string;
  level: string;
  message: string;
  triggered_at: number;
  source_url: string;
  source_label: string;
}

export interface TimelineBucket {
  bucket: number; // unix timestamp, rounded to minute
  total: number;
}

export interface EventSummary {
  event_name: string;
  total_count: number;
  zone_count: number;
  alert_count: number;
  critical_count: number;
  warning_count: number;
  sources: SourceStatus[];
  timestamp: number;
}

// ── In-memory state ──────────────────────────────────────────────────────────

const sources: Map<string, SourceStatus> = new Map();
const aggregatedZones: Map<string, AggregatedZone> = new Map();
const aggregatedFlow: Map<string, AggregatedFlow> = new Map();
const aggregatedAlerts: Map<string, AggregatedAlert> = new Map();

// Timeline: last 2 hours in 1-minute buckets
const TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000;
const BUCKET_SIZE_MS = 60 * 1000;
const timeline: Map<number, number> = new Map();

// Previous zone counts for trend detection
const prevCounts: Map<string, number> = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/\./g, '-') + ':' + u.port;
  } catch {
    return url;
  }
}

function bucketTs(ts: number): number {
  return Math.floor(ts / BUCKET_SIZE_MS) * BUCKET_SIZE_MS;
}

function pruneTimeline() {
  const cutoff = Date.now() - TIMELINE_WINDOW_MS;
  for (const [k] of timeline) {
    if (k < cutoff) timeline.delete(k);
  }
}

function updateTimeline(total: number) {
  const bucket = bucketTs(Date.now());
  // Keep highest total seen in this minute bucket
  const existing = timeline.get(bucket) ?? 0;
  if (total > existing) timeline.set(bucket, total);
  pruneTimeline();
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchJson(url: string, timeoutMs = 4000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Poll one source ───────────────────────────────────────────────────────────

async function pollSource(url: string) {
  const label = sourceLabel(url);
  const status = sources.get(url) ?? { url, label, online: false, lastSeen: null };

  try {
    // Fetch counts, flow, and alerts in parallel
    const [countsData, flowData, alertsData] = await Promise.all([
      fetchJson(`${url}/api/counts`),
      fetchJson(`${url}/api/flow`),
      fetchJson(`${url}/api/alerts`)
    ]);

    status.online = true;
    status.lastSeen = Date.now();
    status.error = undefined;
    sources.set(url, status);

    // ── Merge zones ────────────────────────────────────────────────────────
    const zones: any[] = countsData?.zones ?? [];
    for (const z of zones) {
      const key = `${url}::${z.zone_id}`;
      const prev = prevCounts.get(key);
      let trend: 'up' | 'down' | 'stable' = 'stable';
      if (prev !== undefined) {
        if (z.count > prev) trend = 'up';
        else if (z.count < prev) trend = 'down';
      }
      prevCounts.set(key, z.count ?? 0);

      aggregatedZones.set(key, {
        id: z.zone_id,
        name: z.name,
        capacity: z.capacity ?? 100,
        count: z.count ?? 0,
        pct: z.capacity > 0 ? Math.round(((z.count ?? 0) / z.capacity) * 100) : 0,
        alert_level: z.alert_level ?? null,
        camera_id: z.camera_id ?? '',
        source_url: url,
        source_label: label,
        trend
      });
    }

    // ── Merge flow ─────────────────────────────────────────────────────────
    const flows: any[] = Array.isArray(flowData) ? flowData : [];
    for (const f of flows) {
      const key = `${url}::${f.zone_id}`;
      aggregatedFlow.set(key, {
        zone_id: f.zone_id,
        zone_name: f.zone_name,
        direction_x: f.direction_x,
        direction_y: f.direction_y,
        magnitude: f.magnitude,
        dominant_label: f.dominant_label,
        source_url: url,
        source_label: label
      });
    }

    // Remove flow entries from this source that are no longer present
    for (const [k, v] of aggregatedFlow) {
      if (v.source_url === url && !flows.find(f => `${url}::${f.zone_id}` === k)) {
        aggregatedFlow.delete(k);
      }
    }

    // ── Merge alerts ───────────────────────────────────────────────────────
    // Remove stale alerts from this source
    for (const [k, v] of aggregatedAlerts) {
      if (v.source_url === url) aggregatedAlerts.delete(k);
    }
    const alerts: any[] = Array.isArray(alertsData) ? alertsData : [];
    for (const a of alerts) {
      const key = `${url}::${a.id}`;
      aggregatedAlerts.set(key, {
        id: String(a.id),
        zone_id: a.zone_id,
        zone_name: a.zone_name,
        level: a.level,
        message: a.message,
        triggered_at: a.triggered_at,
        source_url: url,
        source_label: label
      });
    }

  } catch (err: any) {
    status.online = false;
    status.error = err.message;
    sources.set(url, status);

    // Remove stale data from this source
    for (const [k, v] of aggregatedZones) {
      if ((v as AggregatedZone).source_url === url) aggregatedZones.delete(k);
    }
    for (const [k, v] of aggregatedFlow) {
      if ((v as AggregatedFlow).source_url === url) aggregatedFlow.delete(k);
    }
    for (const [k, v] of aggregatedAlerts) {
      if ((v as AggregatedAlert).source_url === url) aggregatedAlerts.delete(k);
    }

    console.warn(`[aggregator] ${label} offline: ${err.message}`);
  }
}

// ── Poll all sources and broadcast ───────────────────────────────────────────

async function pollAll() {
  const urls = Array.from(sources.keys());
  if (urls.length === 0) return;

  await Promise.all(urls.map(pollSource));

  // Compute total
  const total = Array.from(aggregatedZones.values()).reduce((s, z) => s + z.count, 0);
  updateTimeline(total);

  // Broadcast event-wide update
  broadcast({
    type: 'event-update',
    timestamp: Math.floor(Date.now() / 1000),
    summary: getEventSummary(),
    zones: getZones(),
    flow: getFlow(),
    alerts: getAlerts()
  });
}

// ── Public read API ───────────────────────────────────────────────────────────

export function getEventSummary(): EventSummary {
  const zones = Array.from(aggregatedZones.values());
  const alerts = Array.from(aggregatedAlerts.values());
  const total = zones.reduce((s, z) => s + z.count, 0);

  return {
    event_name: process.env.EVENT_NAME ?? 'Live Event',
    total_count: total,
    zone_count: zones.length,
    alert_count: alerts.length,
    critical_count: alerts.filter(a => a.level === 'critical').length,
    warning_count: alerts.filter(a => a.level === 'warning').length,
    sources: Array.from(sources.values()),
    timestamp: Math.floor(Date.now() / 1000)
  };
}

export function getZones(): AggregatedZone[] {
  return Array.from(aggregatedZones.values()).sort((a, b) =>
    a.source_label.localeCompare(b.source_label) || a.name.localeCompare(b.name)
  );
}

export function getFlow(): AggregatedFlow[] {
  return Array.from(aggregatedFlow.values());
}

export function getAlerts(): AggregatedAlert[] {
  return Array.from(aggregatedAlerts.values())
    .sort((a, b) => b.triggered_at - a.triggered_at);
}

export function getTimeline(): TimelineBucket[] {
  pruneTimeline();
  return Array.from(timeline.entries())
    .map(([bucket, total]) => ({ bucket, total }))
    .sort((a, b) => a.bucket - b.bucket);
}

export function getSources(): SourceStatus[] {
  return Array.from(sources.values());
}

// ── Startup ───────────────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startAggregator() {
  const sourcesEnv = process.env.HERD_SOURCES ?? '';
  if (!sourcesEnv.trim()) {
    console.log('[aggregator] HERD_SOURCES not set — aggregation disabled');
    return;
  }

  const urls = sourcesEnv.split(',').map(u => u.trim()).filter(Boolean);
  for (const url of urls) {
    sources.set(url, { url, label: sourceLabel(url), online: false, lastSeen: null });
  }

  const interval = parseInt(process.env.AGGREGATE_INTERVAL_MS ?? '5000', 10);

  console.log(`[aggregator] Starting — ${urls.length} source(s), ${interval}ms interval`);
  urls.forEach(u => console.log(`[aggregator]   • ${u}`));

  // Initial poll immediately
  pollAll();
  intervalHandle = setInterval(pollAll, interval);
}

export function stopAggregator() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
