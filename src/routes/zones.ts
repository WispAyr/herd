import { Router, Request, Response } from 'express';
import { db } from '../db';
import { v4 as uuid } from 'uuid';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const zones = db.prepare(`
    SELECT z.*,
      (SELECT count FROM counts WHERE zone_id = z.id ORDER BY timestamp DESC LIMIT 1) as current_count,
      (SELECT level FROM alerts WHERE zone_id = z.id AND active = 1 ORDER BY triggered_at DESC LIMIT 1) as alert_level
    FROM zones z
    WHERE z.active = 1
    ORDER BY z.name
  `).all();
  res.json(zones);
});

router.post('/', (req: Request, res: Response) => {
  const { name, camera_id, polygon, capacity, alert_warning_pct, alert_critical_pct } = req.body;
  if (!name || !camera_id || !polygon) {
    res.status(400).json({ error: 'name, camera_id, and polygon required' });
    return;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO zones (id, name, camera_id, polygon, capacity, alert_warning_pct, alert_critical_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, camera_id,
    typeof polygon === 'string' ? polygon : JSON.stringify(polygon),
    capacity || 100,
    alert_warning_pct || 0.7,
    alert_critical_pct || 0.9
  );

  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(id);
  res.status(201).json(zone);
});

router.put('/:id', (req: Request, res: Response) => {
  const existing = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Zone not found' });
    return;
  }

  const { name, polygon, capacity, alert_warning_pct, alert_critical_pct } = req.body;
  db.prepare(`
    UPDATE zones SET
      name = COALESCE(?, name),
      polygon = COALESCE(?, polygon),
      capacity = COALESCE(?, capacity),
      alert_warning_pct = COALESCE(?, alert_warning_pct),
      alert_critical_pct = COALESCE(?, alert_critical_pct),
      updated_at = strftime('%s','now')
    WHERE id = ?
  `).run(
    name || null,
    polygon ? (typeof polygon === 'string' ? polygon : JSON.stringify(polygon)) : null,
    capacity || null,
    alert_warning_pct || null,
    alert_critical_pct || null,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req: Request, res: Response) => {
  db.prepare('UPDATE zones SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
