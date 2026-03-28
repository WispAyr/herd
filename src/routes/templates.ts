import { Router, Request, Response } from 'express';
import { db } from '../db';
import { v4 as uuid } from 'uuid';

const router = Router();

// GET /api/templates — list saved templates
router.get('/', (_req: Request, res: Response) => {
  const rows = db.prepare(
    'SELECT id, name, description, created_at FROM templates ORDER BY created_at DESC'
  ).all();
  res.json(rows);
});

// POST /api/templates — save current config as template
router.post('/', (req: Request, res: Response) => {
  const { name, description } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // Snapshot current zones, cameras, gates
  const zones = db.prepare('SELECT * FROM zones').all();
  const cameras = db.prepare('SELECT * FROM cameras').all();
  const gates = db.prepare('SELECT * FROM gates').all();

  const config = JSON.stringify({ zones, cameras, gates });
  const id = uuid();

  db.prepare(
    'INSERT INTO templates (id, name, description, config, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, description || '', config, Math.floor(Date.now() / 1000));

  res.status(201).json({ id, name, description: description || '', created_at: Math.floor(Date.now() / 1000) });
});

// POST /api/templates/:id/load — restore a template
router.post('/:id/load', (req: Request, res: Response) => {
  const row = db.prepare('SELECT config FROM templates WHERE id = ?').get(req.params.id) as { config: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }

  const config = JSON.parse(row.config);

  // Clear current config and restore from template in a transaction
  const restore = db.transaction(() => {
    // Delete existing (order matters for foreign keys)
    db.prepare('DELETE FROM gate_crossings').run();
    db.prepare('DELETE FROM gates').run();
    db.prepare('DELETE FROM counts').run();
    db.prepare('DELETE FROM flow').run();
    db.prepare('DELETE FROM alerts').run();
    db.prepare('DELETE FROM zones').run();
    db.prepare('DELETE FROM cameras').run();

    // Restore cameras
    const insertCamera = db.prepare(
      'INSERT INTO cameras (id, name, go2rtc_stream, width, height, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const c of config.cameras || []) {
      insertCamera.run(c.id, c.name, c.go2rtc_stream, c.width, c.height, c.active, c.created_at, c.updated_at);
    }

    // Restore zones
    const insertZone = db.prepare(
      'INSERT INTO zones (id, name, camera_id, polygon, capacity, alert_warning_pct, alert_critical_pct, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const z of config.zones || []) {
      insertZone.run(z.id, z.name, z.camera_id, z.polygon, z.capacity, z.alert_warning_pct, z.alert_critical_pct, z.active, z.created_at, z.updated_at);
    }

    // Restore gates
    const insertGate = db.prepare(
      'INSERT INTO gates (id, camera_id, name, line_y, active, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const g of config.gates || []) {
      insertGate.run(g.id, g.camera_id, g.name, g.line_y, g.active, g.created_at);
    }
  });

  restore();

  res.json({
    ok: true,
    message: 'Template loaded',
    cameras: (config.cameras || []).length,
    zones: (config.zones || []).length,
    gates: (config.gates || []).length
  });
});

// DELETE /api/templates/:id
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.status(204).end();
});

export default router;
