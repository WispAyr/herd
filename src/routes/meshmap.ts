import { Router, Request, Response } from 'express';

const router = Router();

const MESH_MAPPER_URL = process.env.MESH_MAPPER_URL || 'http://10.42.42.132:5000';
const MESH_MAPPER_AUTH = process.env.MESH_MAPPER_AUTH || 'admin:dronedrone';

function authHeader(): string {
  return 'Basic ' + Buffer.from(MESH_MAPPER_AUTH).toString('base64');
}

async function proxyGet(urlPath: string, res: Response) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${MESH_MAPPER_URL}${urlPath}`, {
      signal: controller.signal,
      headers: { 'Authorization': authHeader() }
    });
    clearTimeout(timeout);
    if (r.ok) {
      const data = await r.json();
      res.json(data);
    } else {
      res.status(r.status).json({ error: `mesh-mapper returned ${r.status}` });
    }
  } catch (e: any) {
    res.status(502).json({ error: 'mesh-mapper unreachable', detail: e.message });
  }
}

// GET /api/meshmap/status
router.get('/status', (_req: Request, res: Response) => {
  proxyGet('/health', res);
});

// GET /api/meshmap/drones
router.get('/drones', (_req: Request, res: Response) => {
  proxyGet('/api/drones', res);
});

// GET /api/meshmap/aircraft
router.get('/aircraft', (_req: Request, res: Response) => {
  proxyGet('/api/aircraft', res);
});

// GET /api/meshmap/weather
router.get('/weather', (_req: Request, res: Response) => {
  proxyGet('/api/weather', res);
});

// GET /api/meshmap/alerts
router.get('/alerts', (_req: Request, res: Response) => {
  proxyGet('/api/alerts/history', res);
});

export default router;
