/**
 * Camera integration — round-robin snapshots from go2rtc,
 * feed to Hailo YOLO inference.
 */

import { db } from './db';
import { BBox, CentroidTracker } from './tracker';
import { parsePolygon, countInZone } from './zones';
import { broadcast } from './ws';

const GO2RTC_URL = process.env.GO2RTC_URL || 'http://localhost:1984';
const HAILO_MODE = process.env.HAILO_MODE || 'auto';
const HAILO_API_URL = process.env.HAILO_API_URL || 'http://localhost:8080';

// Per-camera centroid trackers
const trackers = new Map<string, CentroidTracker>();

// Round-robin state
let cameraQueue: string[] = [];
let queueIdx = 0;
let loopInterval: NodeJS.Timeout | null = null;

export function getTracker(cameraId: string): CentroidTracker {
  if (!trackers.has(cameraId)) trackers.set(cameraId, new CentroidTracker());
  return trackers.get(cameraId)!;
}

async function fetchSnapshot(streamName: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`${GO2RTC_URL}/api/frame.jpeg?src=${encodeURIComponent(streamName)}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function runInference(imageBuffer: Buffer): Promise<BBox[]> {
  if (HAILO_MODE === 'mock') {
    // Return random mock detections for dev
    const count = Math.floor(Math.random() * 8);
    return Array.from({ length: count }, () => ({
      x1: Math.random() * 1600,
      y1: Math.random() * 900,
      x2: Math.random() * 1600 + 100,
      y2: Math.random() * 900 + 100,
      confidence: 0.7 + Math.random() * 0.3,
      class_id: 0
    }));
  }

  try {
    const res = await fetch(`${HAILO_API_URL}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: imageBuffer
    });
    if (!res.ok) return [];
    const data = await res.json() as { detections: BBox[] };
    return (data.detections || []).filter((d: BBox) => d.class_id === 0); // person class only
  } catch {
    return [];
  }
}

function updateZoneCounts(cameraId: string, bboxes: BBox[]) {
  const centroids = bboxes.map(b => ({
    cx: (b.x1 + b.x2) / 2,
    cy: (b.y1 + b.y2) / 2
  }));

  const zones = db.prepare(`
    SELECT id, name, polygon, capacity, alert_warning_pct, alert_critical_pct
    FROM zones WHERE camera_id = ? AND active = 1
  `).all(cameraId) as any[];

  const tracker = getTracker(cameraId);
  const { flow } = tracker.update(bboxes);

  const now = Math.floor(Date.now() / 1000);
  const zoneUpdates: any[] = [];

  for (const zone of zones) {
    const polygon = parsePolygon(zone.polygon);
    const count = countInZone(centroids, polygon);

    // Store count
    db.prepare('INSERT INTO counts (zone_id, count, timestamp) VALUES (?, ?, ?)').run(zone.id, count, now);

    // Store flow
    db.prepare(`
      INSERT INTO flow (zone_id, direction_x, direction_y, magnitude, dominant_label, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(zone.id, flow.direction_x, flow.direction_y, flow.magnitude, flow.dominant_label, now);

    // Check alerts
    const pct = zone.capacity > 0 ? count / zone.capacity : 0;
    let level: string | null = null;
    if (pct >= zone.alert_critical_pct) level = 'critical';
    else if (pct >= zone.alert_warning_pct) level = 'warning';

    // Resolve old alerts for this zone
    db.prepare('UPDATE alerts SET active = 0, resolved_at = ? WHERE zone_id = ? AND active = 1').run(now, zone.id);

    if (level) {
      db.prepare(`
        INSERT INTO alerts (zone_id, level, message, count, capacity, triggered_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(zone.id, level, `Zone "${zone.name}" at ${Math.round(pct * 100)}% capacity`, count, zone.capacity, now);
    }

    zoneUpdates.push({
      zone_id: zone.id,
      name: zone.name,
      count,
      capacity: zone.capacity,
      pct: Math.round(pct * 100),
      alert: level,
      flow: {
        direction_x: flow.direction_x,
        direction_y: flow.direction_y,
        magnitude: flow.magnitude,
        label: flow.dominant_label
      }
    });
  }

  // Broadcast to all WebSocket clients
  broadcast({
    type: 'counts',
    camera_id: cameraId,
    timestamp: now,
    zones: zoneUpdates
  });
}

async function processNextCamera() {
  const cameras = db.prepare('SELECT id, go2rtc_stream FROM cameras WHERE active = 1').all() as any[];
  if (cameras.length === 0) return;

  // Rebuild queue if needed
  if (cameras.length !== cameraQueue.length || !cameras.every((c: any) => cameraQueue.includes(c.id))) {
    cameraQueue = cameras.map((c: any) => c.id);
    queueIdx = 0;
  }

  const camera = cameras[queueIdx % cameras.length];
  queueIdx = (queueIdx + 1) % cameras.length;

  const cameraRow = camera as any;
  const stream = (db.prepare('SELECT go2rtc_stream FROM cameras WHERE id = ?').get(camera.id) as any)?.go2rtc_stream;
  if (!stream) return;

  const frame = await fetchSnapshot(stream);
  if (!frame) return;

  const bboxes = await runInference(frame);
  updateZoneCounts(camera.id, bboxes);
}

export function startCameraLoop(intervalMs = 2000) {
  if (loopInterval) return;
  console.log(`[camera] Starting camera loop (interval: ${intervalMs}ms, mode: ${HAILO_MODE})`);
  loopInterval = setInterval(processNextCamera, intervalMs);
}

export function stopCameraLoop() {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
}
