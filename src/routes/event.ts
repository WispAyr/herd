/**
 * Event-wide aggregated API routes
 * Mounted at /api/event
 */

import { Router, Request, Response } from 'express';
import {
  getEventSummary,
  getZones,
  getFlow,
  getAlerts,
  getTimeline,
  getSources
} from '../aggregator';

const router = Router();

// Helper: check if aggregation is configured
function isConfigured(): boolean {
  return !!(process.env.HERD_SOURCES ?? '').trim();
}

function notConfigured(res: Response) {
  res.status(503).json({
    error: 'No sources configured',
    hint: 'Set HERD_SOURCES env var to comma-separated Herd instance URLs'
  });
}

/** GET /api/event/summary — total headcount, zone breakdown, alert count */
router.get('/summary', (_req: Request, res: Response) => {
  if (!isConfigured()) { notConfigured(res); return; }
  res.json(getEventSummary());
});

/** GET /api/event/zones — all zones from all sources with source labels */
router.get('/zones', (_req: Request, res: Response) => {
  if (!isConfigured()) { notConfigured(res); return; }
  res.json(getZones());
});

/** GET /api/event/flow — aggregated flow data across all sources */
router.get('/flow', (_req: Request, res: Response) => {
  if (!isConfigured()) { notConfigured(res); return; }
  res.json(getFlow());
});

/** GET /api/event/alerts — all active alerts from all sources */
router.get('/alerts', (_req: Request, res: Response) => {
  if (!isConfigured()) { notConfigured(res); return; }
  res.json(getAlerts());
});

/** GET /api/event/timeline — headcount over time, 1-min buckets, last 2 hours */
router.get('/timeline', (_req: Request, res: Response) => {
  if (!isConfigured()) { notConfigured(res); return; }
  res.json(getTimeline());
});

/** GET /api/event/sources — source status */
router.get('/sources', (_req: Request, res: Response) => {
  res.json(getSources());
});

export default router;
