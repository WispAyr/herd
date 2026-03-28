# Herd — Real-Time Crowd Analytics Platform

Real-time crowd analytics for live events. Runs on Raspberry Pi 5 with Hailo-8 AI accelerators doing YOLOv8 person detection on live camera feeds. Counts people per zone, tracks flow direction, detects gate crossings, and alerts when capacity thresholds are hit.

<!-- Screenshot: Dashboard -->
<!-- ![Dashboard](docs/screenshots/dashboard.png) -->

## Architecture

```
                                    ┌──────────────────────────┐
                                    │   go2rtc (RTSP → JPEG)   │
                                    └──────────┬───────────────┘
                                               │ JPEG snapshots
                                               ▼
┌─────────────┐    POST image    ┌─────────────────────────────┐
│  Hailo-8    │◄─────────────────│     Herd Camera Loop        │
│  YOLO API   │────────────────►│  (round-robin, 2s interval) │
│  :8080      │   BBox results   └──────────┬───────────────────┘
└─────────────┘                             │
                                            ▼
                          ┌─────────────────────────────────────┐
                          │          Processing Pipeline         │
                          │                                     │
                          │  ┌──────────┐  ┌────────────────┐  │
                          │  │ Zone     │  │ Centroid       │  │
                          │  │ Counting │  │ Tracker        │  │
                          │  │ (PiP)    │  │ (Flow Vectors) │  │
                          │  └────┬─────┘  └───────┬────────┘  │
                          │       │                │           │
                          │  ┌────┴────┐  ┌───────┴────────┐  │
                          │  │ Gate    │  │ Alert          │  │
                          │  │ Counter │  │ Engine         │  │
                          │  └────┬────┘  └───────┬────────┘  │
                          └───────┼───────────────┼────────────┘
                                  │               │
                    ┌─────────────▼───────────────▼──────────┐
                    │         SQLite (WAL mode)              │
                    │  counts · flow · alerts · gates · ...  │
                    └────────────────┬───────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
     ┌────────────────┐    ┌────────────────┐    ┌──────────────────┐
     │  WebSocket     │    │  REST API      │    │  SentryFlow      │
     │  (live push)   │    │  :3070         │    │  (optional)      │
     └───────┬────────┘    └───────┬────────┘    └──────────────────┘
             │                     │
    ┌────────┴─────────────────────┴────────┐
    │              Web Dashboards            │
    │                                       │
    │  /           Single-node dashboard    │
    │  /event      Event aggregation        │
    │  /analytics  Historical charts        │
    │  /heatmap    Density overlay          │
    │  /mobile     Mobile-optimized         │
    └───────────────────────────────────────┘
```

## Quick Start

### Prerequisites
- Raspberry Pi 5 (8GB recommended) or any Linux/macOS machine
- Node.js 18+
- go2rtc for camera RTSP streams
- Hailo-8 with inference API (or use `HAILO_MODE=mock` for development)

### Installation

```bash
git clone https://github.com/your-org/herd.git
cd herd
npm install
npm run build
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your settings
```

### Running

```bash
# Production
npm start

# Development (with TypeScript watch)
npm run dev

# Mock mode (no hardware needed)
HAILO_MODE=mock npm start
```

Dashboard: `http://localhost:3070`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3070` | HTTP server port |
| `GO2RTC_URL` | `http://localhost:1984` | go2rtc base URL for camera snapshots |
| `HAILO_MODE` | `auto` | Inference mode: `auto` / `direct` / `api` / `mock` |
| `HAILO_API_URL` | `http://localhost:8080` | Hailo inference API endpoint |
| `DB_PATH` | `./data/herd.db` | SQLite database file path |
| `HERD_SOURCES` | *(empty)* | Comma-separated URLs of Herd instances for event aggregation |
| `AGGREGATE_INTERVAL_MS` | `5000` | Poll interval for multi-instance aggregation |
| `EVENT_NAME` | `"Live Event"` | Display name in event dashboard |
| `SENTRYFLOW_URL` | *(empty)* | SentryFlow API URL for external event forwarding |
| `API_KEY` | *(empty)* | API key for public occupancy API (if set, requires X-API-Key header) |

## Web Dashboards

| Route | Description |
|---|---|
| `/` | Single-node dashboard — zone cards, counts, alerts, sparklines, gate counters |
| `/event` | Event-wide aggregated view — polls multiple Herd instances |
| `/analytics` | Historical charts — time-bucketed counts and flow magnitude |
| `/heatmap` | Density heatmap overlay on camera feed |
| `/mobile` | Mobile-optimized dashboard — swipe between zones, large touch-friendly numbers |

All dashboards use a dark theme and are fully responsive.

## API Reference

### Cameras
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/cameras` | List all cameras |
| `PUT` | `/api/cameras/bulk` | Upsert array of cameras |
| `DELETE` | `/api/cameras/:id` | Soft-delete camera |

### Zones
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/zones` | List active zones with current count and alert level |
| `POST` | `/api/zones` | Create zone (name, camera_id, polygon, capacity) |
| `PUT` | `/api/zones/:id` | Update zone (partial) |
| `DELETE` | `/api/zones/:id` | Soft-delete zone |

### Counts
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/counts` | Current headcount per zone + total |
| `GET` | `/api/counts/history?zone=ID&from=TS&to=TS` | Historical time-series |

### History & Analytics
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/history?zone_id=X&period=1h\|6h\|24h\|7d` | Time-bucketed count data |
| `GET` | `/api/history/peak?zone_id=X&period=24h` | Peak occupancy stats |
| `GET` | `/api/history/sparkline?zone_id=X` | SVG sparkline (last hour) |

### Flow
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/flow` | Latest flow vector per zone |
| `GET` | `/api/flow/current` | Current per-zone flow data |
| `GET` | `/api/flow/history?zone_id=X&period=1h` | Flow magnitude over time |

### Heatmap
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/heatmap?camera_id=X&period=5m\|1h` | 20x20 density grid |

### Alerts
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/alerts` | Active capacity alerts |
| `POST` | `/api/alerts/:id/resolve` | Manually resolve alert |

### Gates (Entry/Exit Counting)
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/gates` | List active gates |
| `POST` | `/api/gates` | Create gate (camera_id, name, line_y) |
| `DELETE` | `/api/gates/:id` | Soft-delete gate |
| `GET` | `/api/gates/:id/counts` | Entry/exit totals for a gate |
| `GET` | `/api/gates/all/counts` | All gate counts summary |

### Event Aggregation (multi-instance)
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/event/summary` | Total headcount, zones, alerts, sources |
| `GET` | `/api/event/zones` | All zones from all sources |
| `GET` | `/api/event/flow` | Aggregated flow data |
| `GET` | `/api/event/alerts` | All alerts from all sources |
| `GET` | `/api/event/timeline` | 1-min bucket headcount (last 2 hours) |
| `GET` | `/api/event/sources` | Source status list |

### Public Occupancy API (v1)
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/occupancy` | All zones: counts, capacities, percentages |
| `GET` | `/api/v1/occupancy/:zone_id` | Single zone occupancy |
| `GET` | `/api/v1/occupancy/summary` | Simple totals |
| `GET` | `/api/v1/docs` | OpenAPI 3.0.3 JSON specification |

If `API_KEY` is set, all `/api/v1/*` endpoints require `X-API-Key` header. CORS is enabled for external consumers.

### Other
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check (`{ok: true, service: 'herd'}`) |

## Setup Guide

### 1. Register cameras

```bash
curl -X PUT http://localhost:3070/api/cameras/bulk \
  -H 'Content-Type: application/json' \
  -d '[{"id":"cam-1","name":"Stage Left","go2rtc_stream":"stage-left"}]'
```

### 2. Create zones

```bash
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

### 3. Create gates (optional)

```bash
curl -X POST http://localhost:3070/api/gates \
  -H 'Content-Type: application/json' \
  -d '{"camera_id":"cam-1","name":"Main Entrance","line_y":0.5}'
```

### 4. Multi-node event setup

```bash
# On the aggregator node:
HERD_SOURCES=http://pi-1:3070,http://pi-2:3070 npm start
# Visit /event for the unified view
```

## Detection Input Format

Herd polls go2rtc for JPEG frames and sends them to the Hailo inference API. Expected response:

```json
{
  "detections": [
    { "x1": 120, "y1": 50, "x2": 200, "y2": 300, "confidence": 0.87, "class_id": 0 }
  ]
}
```

Only `class_id: 0` (person) detections are counted.

## Deployment on Raspberry Pi

### Recommended setup

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt install -y nodejs

# Clone and build
git clone https://github.com/your-org/herd.git
cd herd && npm install && npm run build

# Run with PM2
npm install -g pm2
pm2 start dist/index.js --name herd
pm2 save && pm2 startup
```

### go2rtc setup

```yaml
# /etc/go2rtc.yaml
streams:
  stage-left:
    - rtsp://camera-ip:554/stream1
  main-entrance:
    - rtsp://camera-ip-2:554/stream1
```

### Hailo inference API

The Hailo inference API runs as a FastAPI service on port 8080. It accepts JPEG images via POST and returns bounding box detections.

## Data Retention

- Count and flow data is automatically pruned after **7 days**
- Pruning runs on startup and every 6 hours
- SQLite WAL mode for concurrent read/write performance
- Database file: `./data/herd.db` (configurable via `DB_PATH`)

## SentryFlow Integration

When `SENTRYFLOW_URL` is set, Herd will:
- POST crowd count snapshots every 30 seconds to `{SENTRYFLOW_URL}/api/events`
- Forward alert events (warning/critical) in real-time
- All outbound requests are non-blocking with 5s timeout

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **HTTP**: Express 4
- **Database**: better-sqlite3 (WAL mode)
- **WebSocket**: ws
- **Inference**: Hailo-8 via FastAPI (Python)
- **Cameras**: go2rtc (RTSP/WebRTC/MJPEG)
- **Frontend**: Vanilla JS, Canvas charts, SVG sparklines
- **Deployment**: PM2 on Raspberry Pi 5

## License

Proprietary. Internal use only.
