import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

/** GET /api/flow — latest flow vector per zone */
router.get('/', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT f.zone_id, z.name as zone_name,
      f.direction_x, f.direction_y, f.magnitude, f.dominant_label, f.timestamp
    FROM flow f
    JOIN zones z ON z.id = f.zone_id
    WHERE f.id IN (
      SELECT MAX(id) FROM flow GROUP BY zone_id
    )
    AND z.active = 1
    ORDER BY z.name
  `).all();

  res.json(rows);
});

/** Period string to seconds */
function periodToSeconds(period: string): number {
  const map: Record<string, number> = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
  return map[period] || 3600;
}

function bucketSize(period: string): number {
  const map: Record<string, number> = { '1h': 60, '6h': 300, '24h': 900, '7d': 3600 };
  return map[period] || 60;
}

/** GET /api/flow/current — per-zone current flow data */
router.get('/current', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT f.zone_id, z.name as zone_name,
      f.direction_x, f.direction_y, f.magnitude, f.dominant_label, f.timestamp
    FROM flow f
    JOIN zones z ON z.id = f.zone_id
    WHERE f.id IN (
      SELECT MAX(id) FROM flow GROUP BY zone_id
    )
    AND z.active = 1
    ORDER BY z.name
  `).all();

  res.json(rows);
});

/** GET /api/flow/history?zone_id=X&period=1h — flow over time */
router.get('/history', (req: Request, res: Response) => {
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
      ROUND(AVG(magnitude), 2) as avg_magnitude,
      ROUND(AVG(direction_x), 2) as avg_direction_x,
      ROUND(AVG(direction_y), 2) as avg_direction_y,
      COUNT(*) as samples
    FROM flow
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

export default router;
