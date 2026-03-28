#!/usr/bin/env python3
"""
lorawan-bridge.py — The Things Network LoRaWAN bridge for nuro + Herd.

Subscribes to TTN MQTT, receives uplinks from LoRa sensors,
decodes payloads, and feeds data into:
  - Herd (crowd counts, environmental data as external sources)
  - nuro fleet (gateway + sensor visibility)

Supported sensor types (auto-detected from payload):
  - People counters (PIR/ToF/radar) → Herd external count
  - Environmental (temp, humidity, CO₂, noise) → nuro telemetry
  - GPS trackers → nuro asset tracking
  - Door/window sensors → nuro status
  - Generic → logged + forwarded

TTN MQTT v3 format:
  Topic: v3/{app_id}@ttn/devices/{device_id}/up
  Auth: {app_id}@ttn / API_KEY
"""

import asyncio
import json
import os
import sys
import time
import logging
import base64
import struct
from datetime import datetime, timezone
from typing import Optional, Dict, Any

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(name)s %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('lora-bridge')

try:
    import paho.mqtt.client as mqtt
except ImportError:
    log.error("paho-mqtt not installed. Run: pip3 install paho-mqtt")
    sys.exit(1)

try:
    import httpx
except ImportError:
    log.error("httpx not installed. Run: pip3 install httpx")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────

TTN_HOST = os.environ.get('TTN_HOST', 'eu1.cloud.thethings.network')
TTN_PORT = int(os.environ.get('TTN_PORT', '1883'))
TTN_APP_ID = os.environ.get('TTN_APP_ID', '')  # Set this to your app ID
TTN_API_KEY = os.environ.get('TTN_API_KEY', '')
TTN_TENANT = os.environ.get('TTN_TENANT', 'ttn')

HERD_URL = os.environ.get('HERD_URL', 'http://localhost:3051')
NURO_HUB_URL = os.environ.get('NURO_HUB_URL', 'http://172.6.192.75:3960')

# Device type mappings (device_id pattern → sensor type)
# Override via DEVICE_MAP_FILE env var pointing to a JSON file
DEVICE_MAP: Dict[str, str] = {}

# ── Payload Decoders ─────────────────────────────────────────

def decode_people_counter(payload_bytes: bytes, port: int) -> Optional[Dict]:
    """Decode common people counter formats (Milesight, Browan, generic)."""
    if len(payload_bytes) >= 4:
        # Try common formats
        # Milesight VS121: channel(1) + type(1) + count(2)
        if len(payload_bytes) >= 4 and payload_bytes[1] in (0x04, 0x0D):
            count = struct.unpack('<H', payload_bytes[2:4])[0]
            return {'type': 'people_count', 'count': count, 'format': 'milesight'}
        
        # Browan TBHV: occupancy byte at offset 0
        if port == 10 and len(payload_bytes) >= 1:
            return {'type': 'people_count', 'count': payload_bytes[0], 'format': 'browan'}
    
    # Generic: if port=1 and single uint16, assume it's a count
    if port == 1 and len(payload_bytes) == 2:
        count = struct.unpack('>H', payload_bytes)[0]
        if count < 10000:  # sanity check
            return {'type': 'people_count', 'count': count, 'format': 'generic_u16'}
    
    return None


def decode_environment(payload_bytes: bytes, port: int) -> Optional[Dict]:
    """Decode environmental sensor payloads."""
    result = {}
    
    if len(payload_bytes) >= 4:
        # Milesight AM307/AM319 format: channel + type + value pairs
        i = 0
        while i < len(payload_bytes) - 2:
            ch = payload_bytes[i]
            typ = payload_bytes[i+1]
            
            if typ == 0x67 and i + 3 < len(payload_bytes):  # Temperature
                temp = struct.unpack('<h', payload_bytes[i+2:i+4])[0] / 10.0
                result['temperature'] = temp
                i += 4
            elif typ == 0x68 and i + 2 < len(payload_bytes):  # Humidity
                result['humidity'] = payload_bytes[i+2] / 2.0
                i += 3
            elif typ == 0x7D and i + 3 < len(payload_bytes):  # CO2
                result['co2'] = struct.unpack('<H', payload_bytes[i+2:i+4])[0]
                i += 4
            elif typ == 0x6A and i + 3 < len(payload_bytes):  # Noise
                result['noise_db'] = struct.unpack('<H', payload_bytes[i+2:i+4])[0] / 10.0
                i += 4
            else:
                i += 1
    
    if result:
        result['type'] = 'environment'
        return result
    return None


def decode_gps(payload_bytes: bytes, port: int) -> Optional[Dict]:
    """Decode GPS tracker payloads."""
    if len(payload_bytes) >= 9:
        # Common format: lat(4) + lon(4) + alt(1)
        try:
            lat = struct.unpack('<i', payload_bytes[0:4])[0] / 1e6
            lon = struct.unpack('<i', payload_bytes[4:8])[0] / 1e6
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                alt = payload_bytes[8] * 10 if len(payload_bytes) > 8 else 0
                return {'type': 'gps', 'lat': lat, 'lon': lon, 'alt': alt}
        except:
            pass
    return None


def decode_door(payload_bytes: bytes, port: int) -> Optional[Dict]:
    """Decode door/window sensor."""
    if len(payload_bytes) >= 1:
        # Most door sensors: 0=closed, 1=open
        if port in (10, 20, 100) or len(payload_bytes) <= 2:
            state = 'open' if payload_bytes[0] else 'closed'
            return {'type': 'door', 'state': state}
    return None


def auto_decode(raw_payload: str, port: int, device_id: str) -> Dict:
    """Try all decoders, return best match."""
    try:
        payload_bytes = base64.b64decode(raw_payload)
    except:
        return {'type': 'raw', 'hex': raw_payload}
    
    # Check device map first
    device_type = DEVICE_MAP.get(device_id, '')
    
    if device_type == 'people_counter':
        result = decode_people_counter(payload_bytes, port)
        if result: return result
    elif device_type == 'environment':
        result = decode_environment(payload_bytes, port)
        if result: return result
    elif device_type == 'gps':
        result = decode_gps(payload_bytes, port)
        if result: return result
    elif device_type == 'door':
        result = decode_door(payload_bytes, port)
        if result: return result
    
    # Auto-detect: try all decoders
    for decoder in [decode_people_counter, decode_environment, decode_gps, decode_door]:
        result = decoder(payload_bytes, port)
        if result:
            return result
    
    # Fallback: raw hex
    return {'type': 'raw', 'hex': payload_bytes.hex(), 'port': port, 'length': len(payload_bytes)}


# ── MQTT + Forwarding ────────────────────────────────────────

class LoRaBridge:
    def __init__(self):
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        self.http = httpx.Client(timeout=5)
        self.stats = {
            'uplinks': 0,
            'people_counts': 0,
            'environment': 0,
            'errors': 0,
            'start_time': time.time()
        }
        self.devices: Dict[str, Dict] = {}  # Track seen devices
        self._load_device_map()
    
    def _load_device_map(self):
        global DEVICE_MAP
        map_file = os.environ.get('DEVICE_MAP_FILE', '')
        if map_file and os.path.exists(map_file):
            with open(map_file) as f:
                DEVICE_MAP = json.load(f)
            log.info(f"Loaded {len(DEVICE_MAP)} device mappings from {map_file}")
    
    def on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            log.info(f"✅ Connected to TTN MQTT ({TTN_HOST})")
            # Subscribe to all uplinks for this application
            topic = f"v3/{TTN_APP_ID}@{TTN_TENANT}/devices/+/up"
            client.subscribe(topic, qos=0)
            log.info(f"📡 Subscribed: {topic}")
            
            # Also subscribe to join events
            join_topic = f"v3/{TTN_APP_ID}@{TTN_TENANT}/devices/+/join"
            client.subscribe(join_topic, qos=0)
        else:
            log.error(f"❌ MQTT connect failed: rc={rc}")
    
    def on_disconnect(self, client, userdata, flags, rc, properties=None):
        log.warning(f"MQTT disconnected (rc={rc}), will reconnect...")
    
    def on_message(self, client, userdata, msg):
        try:
            self.stats['uplinks'] += 1
            payload = json.loads(msg.payload)
            
            # Extract device info
            end_device = payload.get('end_device_ids', {})
            device_id = end_device.get('device_id', 'unknown')
            dev_eui = end_device.get('dev_eui', '')
            
            # Extract uplink data
            uplink = payload.get('uplink_message', {})
            f_port = uplink.get('f_port', 0)
            raw_payload = uplink.get('frm_payload', '')
            
            # Radio metadata
            rx_meta = uplink.get('rx_metadata', [{}])
            rssi = rx_meta[0].get('rssi', 0) if rx_meta else 0
            snr = rx_meta[0].get('snr', 0) if rx_meta else 0
            gateway_id = rx_meta[0].get('gateway_ids', {}).get('gateway_id', '') if rx_meta else ''
            
            # Decode payload
            decoded = auto_decode(raw_payload, f_port, device_id)
            
            # Update device tracking
            self.devices[device_id] = {
                'dev_eui': dev_eui,
                'last_seen': datetime.now(timezone.utc).isoformat(),
                'rssi': rssi,
                'snr': snr,
                'gateway': gateway_id,
                'last_type': decoded.get('type', 'unknown'),
                'last_data': decoded,
                'uplink_count': self.devices.get(device_id, {}).get('uplink_count', 0) + 1
            }
            
            log.info(f"📡 {device_id}: {decoded.get('type','?')} | RSSI:{rssi} SNR:{snr} | {json.dumps(decoded)}")
            
            # Forward based on type
            if decoded.get('type') == 'people_count':
                self._forward_people_count(device_id, decoded)
            elif decoded.get('type') == 'environment':
                self._forward_environment(device_id, decoded)
            elif decoded.get('type') == 'gps':
                self._forward_gps(device_id, decoded)
            
            # Always forward to nuro as telemetry
            self._forward_nuro_telemetry(device_id, decoded, rssi, snr, gateway_id)
            
        except Exception as e:
            self.stats['errors'] += 1
            log.error(f"Message processing error: {e}")
    
    def _forward_people_count(self, device_id: str, data: dict):
        """Forward people count to Herd."""
        self.stats['people_counts'] += 1
        try:
            r = self.http.post(f"{HERD_URL}/api/external-count", json={
                'source_id': f"lora-{device_id}",
                'source_type': 'lorawan',
                'source': 'lorawan',
                'count': data['count'],
                'bt_devices': 0,
                'bt_strong_signal': 0,
                'ble_devices': 0,
                'multiplier': 1.0,
                'timestamp': time.time()
            })
            if r.status_code == 200:
                log.info(f"→ Herd: {data['count']} people from lora-{device_id}")
            else:
                log.warning(f"Herd POST failed: {r.status_code}")
        except Exception as e:
            log.warning(f"Herd forward failed: {e}")
    
    def _forward_environment(self, device_id: str, data: dict):
        """Forward environmental data to nuro."""
        self.stats['environment'] += 1
        # Could extend Herd or nuro with environmental endpoints
        log.info(f"🌡️ {device_id}: temp={data.get('temperature')}°C humidity={data.get('humidity')}% co2={data.get('co2')}ppm noise={data.get('noise_db')}dB")
    
    def _forward_gps(self, device_id: str, data: dict):
        """Forward GPS data to nuro."""
        log.info(f"📍 {device_id}: {data['lat']},{data['lon']} alt={data.get('alt',0)}m")
    
    def _forward_nuro_telemetry(self, device_id: str, data: dict, rssi: int, snr: float, gateway: str):
        """Forward all uplinks to nuro hub as telemetry."""
        try:
            self.http.post(f"{NURO_HUB_URL}/api/heartbeat", json={
                'node_id': f"lora-{device_id}",
                'role': f"lora-sensor-{data.get('type', 'unknown')}",
                'hostname': device_id,
                'ip_address': f"lorawan:{gateway}",
                'system': {
                    'rssi': rssi,
                    'snr': snr,
                    'gateway': gateway,
                    'sensor_type': data.get('type', 'unknown'),
                    'data': data,
                    'uplinks': self.devices.get(device_id, {}).get('uplink_count', 0)
                }
            })
        except:
            pass  # Non-blocking
    
    def start(self):
        if not TTN_APP_ID:
            log.error("TTN_APP_ID not set! Set it to your TTN application ID.")
            sys.exit(1)
        if not TTN_API_KEY:
            log.error("TTN_API_KEY not set!")
            sys.exit(1)
        
        username = f"{TTN_APP_ID}@{TTN_TENANT}"
        log.info(f"🔌 Connecting to {TTN_HOST}:{TTN_PORT} as {username}")
        
        self.client.username_pw_set(username, TTN_API_KEY)
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        
        # TLS for port 8883
        if TTN_PORT == 8883:
            self.client.tls_set()
        
        self.client.connect(TTN_HOST, TTN_PORT, keepalive=60)
        
        log.info("🚀 LoRa bridge running — waiting for uplinks...")
        log.info(f"   Herd: {HERD_URL}")
        log.info(f"   nuro: {NURO_HUB_URL}")
        log.info(f"   Devices mapped: {len(DEVICE_MAP)}")
        
        self.client.loop_forever()


# ── HTTP status endpoint (optional, runs in thread) ──────────

def start_status_server(bridge: LoRaBridge):
    """Tiny HTTP server for health/stats."""
    from http.server import HTTPServer, BaseHTTPRequestHandler
    import threading
    
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/health':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'ok': True,
                    'service': 'lorawan-bridge',
                    'stats': bridge.stats,
                    'devices': len(bridge.devices),
                    'uptime': int(time.time() - bridge.stats['start_time'])
                }).encode())
            elif self.path == '/devices':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(bridge.devices, default=str).encode())
            else:
                self.send_response(404)
                self.end_headers()
        
        def log_message(self, format, *args):
            pass  # Suppress access logs
    
    port = int(os.environ.get('STATUS_PORT', '3055'))
    server = HTTPServer(('0.0.0.0', port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log.info(f"📊 Status server on :{port} (/health, /devices)")


if __name__ == '__main__':
    bridge = LoRaBridge()
    start_status_server(bridge)
    try:
        bridge.start()
    except KeyboardInterrupt:
        log.info("Shutting down")
        bridge.client.disconnect()
