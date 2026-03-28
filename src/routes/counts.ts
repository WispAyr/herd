import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

// Current headcount per zone
router.get('/', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT z.id as zone_id, z.name, z.capacity,
      COALESCE((SELECT count FROM counts WHERE zone_id = z.id ORDER BY timestamp DESC LIMIT 1), 0) as count,
      (SELECT level FROM alerts WHERE zone_id = z.id AND active = 1 ORDER BY triggered_at DESC LIMIT 1) as alert_level
    FROM zones z WHERE z.active = 1
  `).all();

  const total = (rows as any[]).reduce((s, r) => s + (r.count || 0), 0);
  res.json({ total, zones: rows });
});

// Historical counts
router.get('/history', (req: Request, res: Response) => {
  const { zone, from, to } = req.query;
  if (!zone) {
    res.status(400).json({ error: 'zone parameter required' });
    return;
  }

  const fromTs = from ? parseInt(from as string) : Math.floor(Date.now() / 1000) - 3600;
  const toTs = to ? parseInt(to as string) : Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT zone_id, count, timestamp
    FROM counts
    WHERE zone_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(zone as string, fromTs, toTs);

  res.json(rows);
});

export default router;
