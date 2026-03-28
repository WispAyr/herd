/**
 * Point-in-polygon check for zone membership.
 */

export interface Point {
  x: number;
  y: number;
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  const { x, y } = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function parsePolygon(raw: string): Point[] {
  // Try JSON array first: [{x:0,y:0}, ...]
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }

  // Fall back to space-separated "x,y x,y ..." format
  try {
    return raw.trim().split(/\s+/).map(pair => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    }).filter(p => !isNaN(p.x) && !isNaN(p.y));
  } catch {
    return [];
  }
}

export function countInZone(bboxCentroids: { cx: number; cy: number }[], polygon: Point[]): number {
  return bboxCentroids.filter(c => pointInPolygon({ x: c.cx, y: c.cy }, polygon)).length;
}
