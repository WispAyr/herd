/**
 * Simple centroid tracker for flow detection.
 * Matches detections across frames by nearest centroid.
 */

export interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  confidence: number;
  class_id: number;
}

export interface TrackedObject {
  id: number;
  cx: number;
  cy: number;
  vx: number; // velocity x
  vy: number; // velocity y
  age: number;
  lastSeen: number;
}

export interface FlowResult {
  direction_x: number;
  direction_y: number;
  magnitude: number;
  dominant_label: string;
  count: number;
}

let nextId = 1;

export class CentroidTracker {
  private objects: Map<number, TrackedObject> = new Map();
  private maxDisappeared = 10;
  private maxDistance = 100;

  update(bboxes: BBox[]): { objects: TrackedObject[]; flow: FlowResult } {
    const now = Date.now();
    const centroids = bboxes.map(b => ({
      cx: (b.x1 + b.x2) / 2,
      cy: (b.y1 + b.y2) / 2
    }));

    if (centroids.length === 0) {
      // Age out objects
      for (const [id, obj] of this.objects) {
        obj.age++;
        if (obj.age > this.maxDisappeared) this.objects.delete(id);
      }
      return { objects: [], flow: { direction_x: 0, direction_y: 0, magnitude: 0, dominant_label: 'none', count: 0 } };
    }

    if (this.objects.size === 0) {
      // Register all as new
      for (const c of centroids) {
        this.objects.set(nextId++, { id: nextId - 1, cx: c.cx, cy: c.cy, vx: 0, vy: 0, age: 0, lastSeen: now });
      }
      return { objects: Array.from(this.objects.values()), flow: this.computeFlow() };
    }

    // Match existing objects to new centroids
    const existingIds = Array.from(this.objects.keys());
    const existingObjects = existingIds.map(id => this.objects.get(id)!);

    const used = new Set<number>();
    const matched = new Set<number>();

    for (let ci = 0; ci < centroids.length; ci++) {
      let minDist = Infinity;
      let bestObjIdx = -1;

      for (let oi = 0; oi < existingObjects.length; oi++) {
        if (used.has(oi)) continue;
        const dx = centroids[ci].cx - existingObjects[oi].cx;
        const dy = centroids[ci].cy - existingObjects[oi].cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist && dist < this.maxDistance) {
          minDist = dist;
          bestObjIdx = oi;
        }
      }

      if (bestObjIdx >= 0) {
        const obj = existingObjects[bestObjIdx];
        obj.vx = centroids[ci].cx - obj.cx;
        obj.vy = centroids[ci].cy - obj.cy;
        obj.cx = centroids[ci].cx;
        obj.cy = centroids[ci].cy;
        obj.age = 0;
        obj.lastSeen = now;
        used.add(bestObjIdx);
        matched.add(ci);
      }
    }

    // Register unmatched centroids
    for (let ci = 0; ci < centroids.length; ci++) {
      if (!matched.has(ci)) {
        this.objects.set(nextId++, { id: nextId - 1, cx: centroids[ci].cx, cy: centroids[ci].cy, vx: 0, vy: 0, age: 0, lastSeen: now });
      }
    }

    // Age out unmatched existing
    for (let oi = 0; oi < existingObjects.length; oi++) {
      if (!used.has(oi)) {
        existingObjects[oi].age++;
        if (existingObjects[oi].age > this.maxDisappeared) {
          this.objects.delete(existingIds[oi]);
        }
      }
    }

    return { objects: Array.from(this.objects.values()), flow: this.computeFlow() };
  }

  private computeFlow(): FlowResult {
    const objs = Array.from(this.objects.values()).filter(o => Math.abs(o.vx) + Math.abs(o.vy) > 0.5);
    if (objs.length === 0) return { direction_x: 0, direction_y: 0, magnitude: 0, dominant_label: 'still', count: this.objects.size };

    const avgVx = objs.reduce((s, o) => s + o.vx, 0) / objs.length;
    const avgVy = objs.reduce((s, o) => s + o.vy, 0) / objs.length;
    const magnitude = Math.sqrt(avgVx * avgVx + avgVy * avgVy);

    let dominant_label = 'mixed';
    if (magnitude > 1) {
      const angle = Math.atan2(avgVy, avgVx) * (180 / Math.PI);
      if (angle >= -45 && angle < 45) dominant_label = 'moving-right';
      else if (angle >= 45 && angle < 135) dominant_label = 'moving-down';
      else if (angle >= 135 || angle < -135) dominant_label = 'moving-left';
      else dominant_label = 'moving-up';
    }

    return { direction_x: avgVx, direction_y: avgVy, magnitude, dominant_label, count: this.objects.size };
  }

  getObjects(): TrackedObject[] {
    return Array.from(this.objects.values());
  }

  reset() {
    this.objects.clear();
  }
}
