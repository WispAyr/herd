import { Router, Request, Response } from 'express';
import { db } from '../db';
import { v4 as uuid } from 'uuid';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const cameras = db.prepare('SELECT * FROM cameras ORDER BY name').all();
  res.json(cameras);
});

router.put('/bulk', (req: Request, res: Response) => {
  const cameras: any[] = req.body;
  if (!Array.isArray(cameras)) {
    res.status(400).json({ error: 'Expected array of cameras' });
    return;
  }

  const upsert = db.prepare(`
    INSERT INTO cameras (id, name, go2rtc_stream, width, height, active, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, strftime('%s','now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      go2rtc_stream = excluded.go2rtc_stream,
      width = excluded.width,
      height = excluded.height,
      active = 1,
      updated_at = strftime('%s','now')
  `);

  const insertMany = db.transaction((cams: any[]) => {
    for (const cam of cams) {
      upsert.run(
        cam.id || uuid(),
        cam.name,
        cam.go2rtc_stream || cam.stream,
        cam.width || 1920,
        cam.height || 1080
      );
    }
  });

  insertMany(cameras);
  const result = db.prepare('SELECT * FROM cameras WHERE active = 1').all();
  res.json({ ok: true, cameras: result });
});

router.delete('/:id', (req: Request, res: Response) => {
  db.prepare('UPDATE cameras SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
