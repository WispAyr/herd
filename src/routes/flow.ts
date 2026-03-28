import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

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

export default router;
