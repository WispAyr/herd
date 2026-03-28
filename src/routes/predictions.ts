import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

const LOOKBACK_SECONDS = 30 * 60; // 30 minutes

interface CountRow {
  zone_id: string;
  count: number;
  timestamp: number;
}

interface ZoneRow {
  id: string;
  name: string;
  capacity: number;
}

function computeZonePrediction(zoneId: string, zoneName: string, capacity: number) {
  const now = Math.floor(Date.now() / 1000);
  const lookbackStart = now - LOOKBACK_SECONDS;

  // Get counts from last 30 minutes
  const rows = db.prepare(
    'SELECT count, timestamp FROM counts WHERE zone_id = ? AND timestamp >= ? ORDER BY timestamp ASC'
  ).all(zoneId, lookbackStart) as CountRow[];

  if (rows.length === 0) {
    return {
      zone_id: zoneId,
      zone_name: zoneName,
      capacity,
      current_count: 0,
      rate_per_min: 0,
      trend: 'stable' as const,
      trend_symbol: '\u2192',
      predicted_15m: 0,
      predicted_30m: 0,
      predicted_60m: 0,
      predicted_peak: 0,
      predicted_peak_time: null as string | null,
      confidence: 'low'
    };
  }

  const currentCount = rows[rows.length - 1].count;

  // Calculate rate using exponential smoothing over recent intervals
  // Split into 5-minute buckets and compute weighted rate
  const alpha = 0.3; // smoothing factor — higher = more weight on recent
  let smoothedRate = 0;
  let hasRate = false;

  if (rows.length >= 2) {
    // Compute per-interval rates
    const rates: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      const dt = rows[i].timestamp - rows[i - 1].timestamp;
      if (dt > 0) {
        const dc = rows[i].count - rows[i - 1].count;
        rates.push((dc / dt) * 60); // per minute
      }
    }

    if (rates.length > 0) {
      // Exponential smoothing: weight recent rates more
      smoothedRate = rates[0];
      for (let i = 1; i < rates.length; i++) {
        smoothedRate = alpha * rates[i] + (1 - alpha) * smoothedRate;
      }
      hasRate = true;
    }
  }

  const ratePerMin = Math.round(smoothedRate * 10) / 10;

  // Determine trend
  let trend: string;
  let trendSymbol: string;
  if (ratePerMin > 5) { trend = 'rising_fast'; trendSymbol = '\u2191\u2191'; }
  else if (ratePerMin > 1) { trend = 'rising'; trendSymbol = '\u2191'; }
  else if (ratePerMin > -1) { trend = 'stable'; trendSymbol = '\u2192'; }
  else if (ratePerMin > -5) { trend = 'declining'; trendSymbol = '\u2193'; }
  else { trend = 'declining_fast'; trendSymbol = '\u2193\u2193'; }

  // Predict forward with exponential decay on the rate
  // Rate decays toward 0 over time (events don't grow forever)
  const decayFactor = 0.97; // per minute
  function predictAt(minutes: number): number {
    let predicted = currentCount;
    let rate = smoothedRate;
    for (let m = 0; m < minutes; m++) {
      predicted += rate;
      rate *= decayFactor;
    }
    return Math.max(0, Math.round(predicted));
  }

  const predicted15 = predictAt(15);
  const predicted30 = predictAt(30);
  const predicted60 = predictAt(60);

  // Find predicted peak (when rate crosses zero or hits capacity)
  let peakCount = currentCount;
  let peakMinute = 0;
  if (smoothedRate > 0) {
    let rate = smoothedRate;
    let count = currentCount;
    for (let m = 1; m <= 120; m++) {
      count += rate;
      rate *= decayFactor;
      if (count > peakCount) {
        peakCount = Math.round(count);
        peakMinute = m;
      }
      if (rate < 0.1) break; // rate effectively zero
      if (count >= capacity) { peakCount = capacity; peakMinute = m; break; }
    }
  }

  let peakTime: string | null = null;
  if (peakMinute > 0) {
    const peakTs = new Date((now + peakMinute * 60) * 1000);
    peakTime = peakTs.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  return {
    zone_id: zoneId,
    zone_name: zoneName,
    capacity,
    current_count: currentCount,
    rate_per_min: ratePerMin,
    trend,
    trend_symbol: trendSymbol,
    predicted_15m: predicted15,
    predicted_30m: predicted30,
    predicted_60m: predicted60,
    predicted_peak: peakCount,
    predicted_peak_time: peakTime,
    confidence: hasRate ? (rows.length >= 10 ? 'high' : 'medium') : 'low'
  };
}

// GET /api/predictions — per-zone predictions
router.get('/', (_req: Request, res: Response) => {
  const zones = db.prepare('SELECT id, name, capacity FROM zones WHERE active = 1').all() as ZoneRow[];
  const predictions = zones.map(z => computeZonePrediction(z.id, z.name, z.capacity));
  res.json({ predictions, generated_at: Math.floor(Date.now() / 1000) });
});

// GET /api/predictions/event — event-wide prediction
router.get('/event', (_req: Request, res: Response) => {
  const zones = db.prepare('SELECT id, name, capacity FROM zones WHERE active = 1').all() as ZoneRow[];
  const predictions = zones.map(z => computeZonePrediction(z.id, z.name, z.capacity));

  const totalCurrent = predictions.reduce((s, p) => s + p.current_count, 0);
  const totalCapacity = predictions.reduce((s, p) => s + p.capacity, 0);
  const totalRate = predictions.reduce((s, p) => s + p.rate_per_min, 0);
  const total15 = predictions.reduce((s, p) => s + p.predicted_15m, 0);
  const total30 = predictions.reduce((s, p) => s + p.predicted_30m, 0);
  const total60 = predictions.reduce((s, p) => s + p.predicted_60m, 0);

  // Overall trend
  let trend: string;
  let trendSymbol: string;
  const r = Math.round(totalRate * 10) / 10;
  if (r > 10) { trend = 'rising_fast'; trendSymbol = '\u2191\u2191'; }
  else if (r > 2) { trend = 'rising'; trendSymbol = '\u2191'; }
  else if (r > -2) { trend = 'stable'; trendSymbol = '\u2192'; }
  else if (r > -10) { trend = 'declining'; trendSymbol = '\u2193'; }
  else { trend = 'declining_fast'; trendSymbol = '\u2193\u2193'; }

  // Peak: find the zone with latest predicted peak
  const peakZone = predictions
    .filter(p => p.predicted_peak_time)
    .sort((a, b) => b.predicted_peak - a.predicted_peak)[0];

  res.json({
    total_current: totalCurrent,
    total_capacity: totalCapacity,
    rate_per_min: r,
    trend,
    trend_symbol: trendSymbol,
    predicted_15m: total15,
    predicted_30m: total30,
    predicted_60m: total60,
    predicted_peak: peakZone ? peakZone.predicted_peak : totalCurrent,
    predicted_peak_time: peakZone ? peakZone.predicted_peak_time : null,
    peak_zone: peakZone ? peakZone.zone_name : null,
    zone_count: zones.length,
    generated_at: Math.floor(Date.now() / 1000)
  });
});

export default router;
