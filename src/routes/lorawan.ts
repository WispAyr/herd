import { Router, Request, Response } from 'express';

const router = Router();

const LORA_BRIDGE_URL = process.env.LORA_BRIDGE_URL || 'http://localhost:3055';

async function proxyGet(url: string, res: Response) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (r.ok) {
      const data = await r.json();
      res.json(data);
    } else {
      res.status(r.status).json({ error: `Bridge returned ${r.status}` });
    }
  } catch (e: any) {
    res.status(502).json({ error: 'LoRa bridge unreachable', detail: e.message });
  }
}

router.get('/gateways', (_req: Request, res: Response) => {
  proxyGet(`${LORA_BRIDGE_URL}/gateways`, res);
});

router.get('/devices', (_req: Request, res: Response) => {
  proxyGet(`${LORA_BRIDGE_URL}/devices`, res);
});

router.get('/health', (_req: Request, res: Response) => {
  proxyGet(`${LORA_BRIDGE_URL}/health`, res);
});

export default router;
