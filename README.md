# 🐂 Herd — Crowd Analytics Platform

Real-time crowd analytics for live events. Consumes YOLO person detections from Hailo hardware, counts people per zone, tracks flow direction, and alerts when capacity thresholds are hit.

## Quick Start

```bash
# Install deps
npm install

# Build
npm run build

# Copy env
cp .env.example .env

# Start
npm start
# or with PM2:
pm2 start ecosystem.config.js
```

Dashboard: `http://localhost:3070`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3070` | HTTP port |
| `GO2RTC_URL` | `http://localhost:1984` | go2rtc base URL |
| `HAILO_MODE` | `auto` | `auto` / `direct` / `api` / `mock` |
| `HAILO_API_URL` | `http://localhost:8080` | Hailo inference API (when mode=api) |
| `DB_PATH` | `./data/herd.db` | SQLite database path |

## API Reference

### Cameras
- `GET /api/cameras` — list active cameras
- `PUT /api/cameras/bulk` — register/update cameras (array)

### Zones
- `GET /api/zones` — list zones with current counts
- `POST /api/zones` — create zone
- `PUT /api/zones/:id` — update zone
- `DELETE /api/zones/:id` — soft-delete zone

### Counts
- `GET /api/counts` — current headcounts per zone + total
- `GET /api/counts/history?zone=<id>&from=<unix>&to=<unix>` — time-series

### Flow
- `GET /api/flow` — current movement direction per zone

### Alerts
- `GET /api/alerts` — active capacity alerts
- `POST /api/alerts/:id/resolve` — manually resolve alert

### Other
- `GET /health` — health check

## Zone Setup Example

```bash
# 1. Register a camera
curl -X PUT http://localhost:3070/api/cameras/bulk \
  -H 'Content-Type: application/json' \
  -d '[{"id":"cam-1","name":"Stage Left","go2rtc_stream":"stage-left"}]'

# 2. Create a zone (polygon as array of {x,y} points, normalized 0-1 or pixel coords)
curl -X POST http://localhost:3070/api/zones \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Pit Area",
    "camera_id": "cam-1",
    "polygon": [{"x":100,"y":200},{"x":800,"y":200},{"x":800,"y":700},{"x":100,"y":700}],
    "capacity": 200,
    "alert_warning_pct": 0.7,
    "alert_critical_pct": 0.9
  }'
```

## Detection Input Format (from Hailo)

Herd expects Hailo to POST to the inference endpoint, or Herd polls go2rtc for frames and calls Hailo API. Expected detection format:

```json
{
  "detections": [
    { "x1": 120, "y1": 50, "x2": 200, "y2": 300, "confidence": 0.87, "class_id": 0 }
  ]
}
```

Only `class_id: 0` (person) detections are counted.

## Architecture

```
go2rtc (RTSP/MJPEG) 
  → Herd camera loop (round-robin snapshots)
    → Hailo YOLO inference
      → BBox extraction (persons only)
        → Zone counting (point-in-polygon)
        → Centroid tracking (flow detection)
        → SQLite storage
          → WebSocket broadcast → Dashboard
```
