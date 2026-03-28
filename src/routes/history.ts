/**
 * Historical Charts API
 * Mounted at /api/history
 */

import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

/** Period string → seconds */
function periodToSeconds(period: string): number {
  const map: Record<string, number> = {
    '1h': 3600,
    '6h': 21600,
    '24h': 86400,
    '7d': 604800
  };
  return map[period] || 3600;
}

/** Period → bucket size in seconds for reasonable granularity */
function bucketSize(period: string): number {
  const map: Record<string, number> = {
    '1h': 60,      // 1-min buckets
    '6h': 300,     // 5-min buckets
    '24h': 900,    // 15-min buckets
    '7d': 3600     // 1-hour buckets
  };
  return map[period] || 60;
}

/**
 * GET /api/history?zone_id=X&period=1h|6h|24h|7d
 * Returns time-bucketed count data
 */
router.get('/', (req: Request, res: Response) => {
  const { zone_id, period } = req.query;
  if (!zone_id) {
    res.status(400).json({ error: 'zone_id parameter required' });
    return;
  }

  const p = (period as string) || '1h';
  const seconds = periodToSeconds(p);
  const bucket = bucketSize(p);
  const now = Math.floor(Date.now() / 1000);
  const from = now - seconds;

  const rows = db.prepare(`
    SELECT
      (timestamp / ? * ?) as bucket,
      ROUND(AVG(count)) as avg_count,
      MAX(count) as max_count,
      MIN(count) as min_count,
      COUNT(*) as samples
    FROM counts
    WHERE zone_id = ? AND timestamp >= ?
    GROUP BY (timestamp / ? * ?)
    ORDER BY bucket ASC
  `).all(bucket, bucket, zone_id as string, from, bucket, bucket);

  res.json({
    zone_id,
    period: p,
    bucket_size: bucket,
    from,
    to: now,
    buckets: rows
  });
});

/**
 * GET /api/history/peak?zone_id=X&period=24h
 * Returns peak occupancy stats
 */
router.get('/peak', (req: Request, res: Response) => {
  const { zone_id, period } = req.query;
  if (!zone_id) {
    res.status(400).json({ error: 'zone_id parameter required' });
    return;
  }

  const p = (period as string) || '24h';
  const seconds = periodToSeconds(p);
  const now = Math.floor(Date.now() / 1000);
  const from = now - seconds;

  const peak = db.prepare(`
    SELECT count as peak_count, timestamp as peak_time
    FROM counts
    WHERE zone_id = ? AND timestamp >= ?
    ORDER BY count DESC
    LIMIT 1
  `).get(zone_id as string, from) as any;

  const avg = db.prepare(`
    SELECT ROUND(AVG(count), 1) as avg_count, COUNT(*) as samples
    FROM counts
    WHERE zone_id = ? AND timestamp >= ?
  `).get(zone_id as string, from) as any;

  const zone = db.prepare('SELECT name, capacity FROM zones WHERE id = ?').get(zone_id as string) as any;

  res.json({
    zone_id,
    zone_name: zone?.name || null,
    capacity: zone?.capacity || null,
    period: p,
    peak_count: peak?.peak_count ?? 0,
    peak_time: peak?.peak_time ?? null,
    avg_count: avg?.avg_count ?? 0,
    samples: avg?.samples ?? 0
  });
});

/**
 * GET /api/history/sparkline?zone_id=X
 * Returns SVG sparkline for the last hour (used inline on dashboard)
 */
router.get('/sparkline', (req: Request, res: Response) => {
  const { zone_id } = req.query;
  if (!zone_id) {
    res.status(400).json({ error: 'zone_id parameter required' });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const from = now - 3600; // last hour
  const bucket = 60; // 1-min buckets

  const rows = db.prepare(`
    SELECT
      (timestamp / ? * ?) as bucket,
      ROUND(AVG(count)) as avg_count
    FROM counts
    WHERE zone_id = ? AND timestamp >= ?
    GROUP BY (timestamp / ? * ?)
    ORDER BY bucket ASC
  `).all(bucket, bucket, zone_id as string, from, bucket, bucket) as any[];

  if (rows.length < 2) {
    res.type('image/svg+xml').send(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30" viewBox="0 0 120 30"><text x="60" y="18" text-anchor="middle" fill="#7070a0" font-size="8">No data</text></svg>'
    );
    return;
  }

  const W = 120, H = 30, PAD = 2;
  const maxVal = Math.max(...rows.map(r => r.avg_count), 1);
  const minTs = rows[0].bucket;
  const maxTs = rows[rows.length - 1].bucket;
  const tsRange = maxTs - minTs || 1;

  const points = rows.map(r => {
    const x = PAD + ((r.bucket - minTs) / tsRange) * (W - PAD * 2);
    const y = H - PAD - ((r.avg_count / maxVal) * (H - PAD * 2));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const fillPoints = `${(PAD).toFixed(1)},${(H - PAD).toFixed(1)} ${points} ${(W - PAD).toFixed(1)},${(H - PAD).toFixed(1)}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#00ff88" stop-opacity="0.3"/>
    <stop offset="100%" stop-color="#00ff88" stop-opacity="0.05"/>
  </linearGradient></defs>
  <polygon points="${fillPoints}" fill="url(#sg)"/>
  <polyline points="${points}" fill="none" stroke="#00ff88" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

  res.type('image/svg+xml').send(svg);
});

export default router;
