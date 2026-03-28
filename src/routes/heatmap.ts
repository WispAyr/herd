/**
 * Heatmap API
 * Mounted at /api/heatmap
 */

import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();
const GRID_SIZE = 20;

/**
 * GET /api/heatmap?camera_id=X&period=5m|1h
 * Returns a 20x20 density grid based on detection centroids
 */
router.get('/', (req: Request, res: Response) => {
  const { camera_id, period } = req.query;
  if (!camera_id) {
    res.status(400).json({ error: 'camera_id parameter required' });
    return;
  }

  const periodSec: Record<string, number> = { '5m': 300, '1h': 3600 };
  const seconds = periodSec[(period as string) || '5m'] || 300;
  const now = Math.floor(Date.now() / 1000);
  const from = now - seconds;

  // Get camera dimensions
  const camera = db.prepare('SELECT width, height FROM cameras WHERE id = ?').get(camera_id as string) as any;
  const camW = camera?.width || 1920;
  const camH = camera?.height || 1080;

  // Get all counts with zone polygons for this camera
  const zones = db.prepare(`
    SELECT z.id, z.polygon FROM zones WHERE z.camera_id = ? AND z.active = 1
  `).all(camera_id as string) as any[];

  // Get raw centroids from counts — we'll reconstruct from flow data
  // Actually, we need centroid positions. Since we only store counts per zone,
  // we'll use the flow table to build a heatmap based on zone center-of-mass.
  // For a true centroid heatmap, we'd need to store raw detections.
  // Instead, build from count data weighted by zone polygon centers.

  // Initialize grid
  const grid: number[][] = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(0));

  for (const zone of zones) {
    let polygon: { x: number; y: number }[];
    try {
      const raw = zone.polygon;
      const parsed = JSON.parse(raw);
      polygon = Array.isArray(parsed) ? parsed : [];
    } catch {
      try {
        polygon = zone.polygon.trim().split(/\s+/).map((p: string) => {
          const [x, y] = p.split(',').map(Number);
          return { x, y };
        });
      } catch { polygon = []; }
    }

    if (polygon.length === 0) continue;

    // Get average count for this zone in the period
    const row = db.prepare(`
      SELECT AVG(count) as avg_count FROM counts
      WHERE zone_id = ? AND timestamp >= ?
    `).get(zone.id, from) as any;
    const avgCount = row?.avg_count || 0;
    if (avgCount === 0) continue;

    // Distribute count across polygon area in the grid
    // Find bounding box of polygon in grid coordinates
    const xs = polygon.map(p => p.x);
    const ys = polygon.map(p => p.y);
    const minGX = Math.max(0, Math.floor((Math.min(...xs) / camW) * GRID_SIZE));
    const maxGX = Math.min(GRID_SIZE - 1, Math.floor((Math.max(...xs) / camW) * GRID_SIZE));
    const minGY = Math.max(0, Math.floor((Math.min(...ys) / camH) * GRID_SIZE));
    const maxGY = Math.min(GRID_SIZE - 1, Math.floor((Math.max(...ys) / camH) * GRID_SIZE));

    const cellCount = Math.max(1, (maxGX - minGX + 1) * (maxGY - minGY + 1));
    const perCell = avgCount / cellCount;

    for (let gy = minGY; gy <= maxGY; gy++) {
      for (let gx = minGX; gx <= maxGX; gx++) {
        // Check if grid cell center is inside polygon (simple point-in-polygon)
        const cx = ((gx + 0.5) / GRID_SIZE) * camW;
        const cy = ((gy + 0.5) / GRID_SIZE) * camH;
        if (pointInPoly(cx, cy, polygon)) {
          grid[gy][gx] += perCell;
        }
      }
    }
  }

  // Normalize to 0-1
  const maxVal = Math.max(...grid.flat(), 0.001);
  const normalized = grid.map(row => row.map(v => Math.round((v / maxVal) * 100) / 100));

  res.json({
    camera_id,
    period: (period as string) || '5m',
    grid_size: GRID_SIZE,
    width: camW,
    height: camH,
    grid: normalized,
    max_density: maxVal
  });
});

function pointInPoly(x: number, y: number, polygon: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export default router;
