/**
 * Public Occupancy API v1
 * Mounted at /api/v1
 * Optional API key auth via API_KEY env var
 */

import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';

const router = Router();
const API_KEY = process.env.API_KEY || '';

// CORS headers for external consumers
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  next();
});

// OPTIONS preflight
router.options('*', (_req: Request, res: Response) => {
  res.sendStatus(204);
});

// API key auth middleware (only if API_KEY is set)
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) { next(); return; }
  const key = req.headers['x-api-key'] as string;
  if (key !== API_KEY) {
    res.status(401).json({ error: 'Invalid or missing API key', hint: 'Provide X-API-Key header' });
    return;
  }
  next();
}

router.use(authMiddleware);

/** GET /api/v1/occupancy — current counts, capacities, percentages for all zones */
router.get('/occupancy', (_req: Request, res: Response) => {
  const zones = db.prepare(`
    SELECT z.id, z.name, z.capacity, z.camera_id,
      COALESCE((SELECT count FROM counts WHERE zone_id = z.id ORDER BY timestamp DESC LIMIT 1), 0) as current_count,
      (SELECT level FROM alerts WHERE zone_id = z.id AND active = 1 ORDER BY triggered_at DESC LIMIT 1) as alert_level
    FROM zones z WHERE z.active = 1
    ORDER BY z.name
  `).all() as any[];

  const result = zones.map(z => ({
    zone_id: z.id,
    name: z.name,
    camera_id: z.camera_id,
    current_count: z.current_count,
    capacity: z.capacity,
    occupancy_pct: z.capacity > 0 ? Math.round((z.current_count / z.capacity) * 100) : 0,
    alert_level: z.alert_level || null
  }));

  const total = result.reduce((s, z) => s + z.current_count, 0);
  const totalCapacity = result.reduce((s, z) => s + z.capacity, 0);

  res.json({
    timestamp: new Date().toISOString(),
    total_count: total,
    total_capacity: totalCapacity,
    total_occupancy_pct: totalCapacity > 0 ? Math.round((total / totalCapacity) * 100) : 0,
    zone_count: result.length,
    zones: result
  });
});

/** GET /api/v1/occupancy/:zone_id — single zone */
router.get('/occupancy/:zone_id', (req: Request, res: Response) => {
  const zone = db.prepare(`
    SELECT z.id, z.name, z.capacity, z.camera_id,
      COALESCE((SELECT count FROM counts WHERE zone_id = z.id ORDER BY timestamp DESC LIMIT 1), 0) as current_count,
      (SELECT level FROM alerts WHERE zone_id = z.id AND active = 1 ORDER BY triggered_at DESC LIMIT 1) as alert_level
    FROM zones z WHERE z.id = ? AND z.active = 1
  `).get(req.params.zone_id) as any;

  if (!zone) {
    res.status(404).json({ error: 'Zone not found' });
    return;
  }

  res.json({
    timestamp: new Date().toISOString(),
    zone_id: zone.id,
    name: zone.name,
    camera_id: zone.camera_id,
    current_count: zone.current_count,
    capacity: zone.capacity,
    occupancy_pct: zone.capacity > 0 ? Math.round((zone.current_count / zone.capacity) * 100) : 0,
    alert_level: zone.alert_level || null
  });
});

/** GET /api/v1/occupancy/summary — simple totals */
router.get('/occupancy/summary', (_req: Request, res: Response) => {
  const row = db.prepare(`
    SELECT
      COUNT(*) as zone_count,
      SUM(COALESCE((SELECT count FROM counts WHERE zone_id = z.id ORDER BY timestamp DESC LIMIT 1), 0)) as total_count,
      SUM(z.capacity) as total_capacity
    FROM zones z WHERE z.active = 1
  `).get() as any;

  const total = row?.total_count || 0;
  const cap = row?.total_capacity || 0;

  const alertCount = db.prepare('SELECT COUNT(*) as c FROM alerts WHERE active = 1').get() as any;

  res.json({
    timestamp: new Date().toISOString(),
    total_count: total,
    total_capacity: cap,
    total_occupancy_pct: cap > 0 ? Math.round((total / cap) * 100) : 0,
    zone_count: row?.zone_count || 0,
    active_alerts: alertCount?.c || 0
  });
});

/** GET /api/v1/docs — OpenAPI/Swagger JSON */
router.get('/docs', (_req: Request, res: Response) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'Herd Occupancy API',
      version: '1.0.0',
      description: 'Real-time crowd occupancy data from Herd edge analytics nodes.'
    },
    servers: [{ url: '/api/v1' }],
    security: API_KEY ? [{ apiKey: [] }] : [],
    components: {
      securitySchemes: API_KEY ? {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' }
      } : {},
      schemas: {
        OccupancyResponse: {
          type: 'object',
          properties: {
            timestamp: { type: 'string', format: 'date-time' },
            total_count: { type: 'integer' },
            total_capacity: { type: 'integer' },
            total_occupancy_pct: { type: 'integer' },
            zone_count: { type: 'integer' },
            zones: {
              type: 'array',
              items: { '$ref': '#/components/schemas/ZoneOccupancy' }
            }
          }
        },
        ZoneOccupancy: {
          type: 'object',
          properties: {
            zone_id: { type: 'string' },
            name: { type: 'string' },
            camera_id: { type: 'string' },
            current_count: { type: 'integer' },
            capacity: { type: 'integer' },
            occupancy_pct: { type: 'integer' },
            alert_level: { type: 'string', nullable: true, enum: ['warning', 'critical', null] }
          }
        },
        SummaryResponse: {
          type: 'object',
          properties: {
            timestamp: { type: 'string', format: 'date-time' },
            total_count: { type: 'integer' },
            total_capacity: { type: 'integer' },
            total_occupancy_pct: { type: 'integer' },
            zone_count: { type: 'integer' },
            active_alerts: { type: 'integer' }
          }
        }
      }
    },
    paths: {
      '/occupancy': {
        get: {
          summary: 'Get occupancy for all zones',
          responses: { '200': { description: 'Current occupancy data', content: { 'application/json': { schema: { '$ref': '#/components/schemas/OccupancyResponse' } } } } }
        }
      },
      '/occupancy/{zone_id}': {
        get: {
          summary: 'Get occupancy for a single zone',
          parameters: [{ name: 'zone_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Zone occupancy data', content: { 'application/json': { schema: { '$ref': '#/components/schemas/ZoneOccupancy' } } } },
            '404': { description: 'Zone not found' }
          }
        }
      },
      '/occupancy/summary': {
        get: {
          summary: 'Get simple totals',
          responses: { '200': { description: 'Summary data', content: { 'application/json': { schema: { '$ref': '#/components/schemas/SummaryResponse' } } } } }
        }
      },
      '/docs': {
        get: {
          summary: 'OpenAPI specification',
          responses: { '200': { description: 'This document' } }
        }
      }
    }
  });
});

export default router;
