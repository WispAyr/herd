import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT a.*, z.name as zone_name
    FROM alerts a
    JOIN zones z ON z.id = a.zone_id
    WHERE a.active = 1
    ORDER BY a.triggered_at DESC
  `).all();

  res.json(rows);
});

router.post('/:id/resolve', (req: Request, res: Response) => {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE alerts SET active = 0, resolved_at = ? WHERE id = ?').run(now, req.params.id);
  res.json({ ok: true });
});

export default router;
