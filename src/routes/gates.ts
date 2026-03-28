/**
 * Gate counting API
 * Mounted at /api/gates
 */

import { Router, Request, Response } from 'express';
import { db } from '../db';
import { v4 as uuid } from 'uuid';

const router = Router();

/** GET /api/gates — list all active gates */
router.get('/', (_req: Request, res: Response) => {
  const gates = db.prepare(`
    SELECT g.*, c.name as camera_name
    FROM gates g
    LEFT JOIN cameras c ON c.id = g.camera_id
    WHERE g.active = 1
    ORDER BY g.name
  `).all();
  res.json(gates);
});

/** POST /api/gates — create a gate */
router.post('/', (req: Request, res: Response) => {
  const { camera_id, name, line_y } = req.body;
  if (!camera_id || !name) {
    res.status(400).json({ error: 'camera_id and name required' });
    return;
  }

  const id = uuid();
  db.prepare('INSERT INTO gates (id, camera_id, name, line_y) VALUES (?, ?, ?, ?)').run(
    id, camera_id, name, line_y ?? 0.5
  );

  const gate = db.prepare('SELECT * FROM gates WHERE id = ?').get(id);
  res.status(201).json(gate);
});

/** DELETE /api/gates/:id — soft delete */
router.delete('/:id', (req: Request, res: Response) => {
  db.prepare('UPDATE gates SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/** GET /api/gates/:id/counts — entry/exit totals */
router.get('/:id/counts', (req: Request, res: Response) => {
  const { from, to } = req.query;
  const now = Math.floor(Date.now() / 1000);
  const fromTs = from ? parseInt(from as string) : now - 86400; // default last 24h
  const toTs = to ? parseInt(to as string) : now;

  const gate = db.prepare('SELECT * FROM gates WHERE id = ?').get(req.params.id) as any;
  if (!gate) {
    res.status(404).json({ error: 'Gate not found' });
    return;
  }

  const entries = db.prepare(`
    SELECT COUNT(*) as count FROM gate_crossings
    WHERE gate_id = ? AND direction = 'entry' AND timestamp >= ? AND timestamp <= ?
  `).get(req.params.id, fromTs, toTs) as any;

  const exits = db.prepare(`
    SELECT COUNT(*) as count FROM gate_crossings
    WHERE gate_id = ? AND direction = 'exit' AND timestamp >= ? AND timestamp <= ?
  `).get(req.params.id, fromTs, toTs) as any;

  res.json({
    gate_id: req.params.id,
    gate_name: gate.name,
    camera_id: gate.camera_id,
    line_y: gate.line_y,
    from: fromTs,
    to: toTs,
    entries: entries?.count || 0,
    exits: exits?.count || 0,
    net: (entries?.count || 0) - (exits?.count || 0)
  });
});

/** GET /api/gates/all/counts — all gate counts summary */
router.get('/all/counts', (_req: Request, res: Response) => {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 86400;

  const gates = db.prepare('SELECT * FROM gates WHERE active = 1').all() as any[];
  const result = gates.map(g => {
    const entries = db.prepare(
      "SELECT COUNT(*) as count FROM gate_crossings WHERE gate_id = ? AND direction = 'entry' AND timestamp >= ?"
    ).get(g.id, from) as any;
    const exits = db.prepare(
      "SELECT COUNT(*) as count FROM gate_crossings WHERE gate_id = ? AND direction = 'exit' AND timestamp >= ?"
    ).get(g.id, from) as any;

    return {
      gate_id: g.id,
      gate_name: g.name,
      camera_id: g.camera_id,
      entries: entries?.count || 0,
      exits: exits?.count || 0,
      net: (entries?.count || 0) - (exits?.count || 0)
    };
  });

  res.json(result);
});

export default router;
