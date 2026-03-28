import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

/**
 * POST /api/external-count
 * Accept crowd estimates from non-camera sources (BLE, WiFi probe, etc.)
 * Body: { source_id, source?: string, count, bt_devices?, bt_strong_signal?, ble_devices?, multiplier?, timestamp? }
 */
router.post('/', (req: Request, res: Response) => {
  const { source_id, source, count, ...rest } = req.body;

  if (!source_id || count === undefined) {
    res.status(400).json({ error: 'source_id and count required' });
    return;
  }

  const ts = rest.timestamp ? Math.floor(rest.timestamp) : Math.floor(Date.now() / 1000);
  const sourceType = source || rest.source_type || 'bluetooth';

  const metadata = JSON.stringify({
    bt_devices: rest.bt_devices,
    bt_strong_signal: rest.bt_strong_signal,
    ble_devices: rest.ble_devices,
    multiplier: rest.multiplier,
  });

  db.prepare(`
    INSERT INTO external_counts (source_id, source_type, count, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(source_id, sourceType, count, metadata, ts);

  res.json({ ok: true, source_id, count, timestamp: ts });
});

/**
 * GET /api/external-count
 * Latest external counts per source.
 */
router.get('/', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT e.source_id, e.source_type, e.count, e.metadata, e.timestamp
    FROM external_counts e
    INNER JOIN (
      SELECT source_id, MAX(timestamp) as max_ts
      FROM external_counts
      GROUP BY source_id
    ) latest ON e.source_id = latest.source_id AND e.timestamp = latest.max_ts
    WHERE e.timestamp > strftime('%s','now') - 120
  `).all();

  const sources = (rows as any[]).map(r => ({
    ...r,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    stale: (Math.floor(Date.now() / 1000) - r.timestamp) > 60
  }));

  const total = sources.reduce((s, r) => s + (r.count || 0), 0);
  res.json({ total, sources });
});

/**
 * GET /api/external-count/history?source_id=X&period=1h
 */
router.get('/history', (req: Request, res: Response) => {
  const { source_id, period } = req.query;
  if (!source_id) {
    res.status(400).json({ error: 'source_id required' });
    return;
  }

  const periods: Record<string, number> = {
    '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800
  };
  const secs = periods[(period as string) || '1h'] || 3600;
  const cutoff = Math.floor(Date.now() / 1000) - secs;

  const rows = db.prepare(`
    SELECT count, timestamp FROM external_counts
    WHERE source_id = ? AND timestamp > ?
    ORDER BY timestamp ASC
  `).all(source_id, cutoff);

  res.json({ source_id, period: period || '1h', data: rows });
});

export default router;
