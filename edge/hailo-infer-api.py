#!/usr/bin/env python3
"""
Hailo YOLOv8 Persistent Inference API.
Enters InferVStreams context ONCE and keeps it open forever.
Single-threaded inference serialised via asyncio lock.
"""
import io, os, sys, time, logging, glob, asyncio
import numpy as np
from PIL import Image
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("hailo")

CONF = float(os.environ.get("HAILO_CONF", "0.35"))
PORT = int(os.environ.get("PORT", "8080"))

# Global pipeline state
_pipeline = None   # _pyhailort.InferVStreams (C++ object)
_ctx = None        # Python InferVStreams wrapper (keeps reference alive)
_input_name = None
_lock = asyncio.Lock()
hailo_ready = False


def init_hailo():
    """Open Hailo pipeline and enter InferVStreams context — stays open for process lifetime."""
    global _pipeline, _ctx, _input_name, hailo_ready
    
    from hailo_platform import (HEF, VDevice, FormatType, InferVStreams,
                                 InputVStreamParams, OutputVStreamParams,
                                 HailoSchedulingAlgorithm)
    
    model = os.environ.get("HAILO_MODEL", "")
    if not model:
        # Detection models only — exclude pose/seg variants
        candidates = [f for f in glob.glob("/usr/share/hailo-models/yolov8*_h8*.hef")
                       if 'pose' not in f and 'seg' not in f]
        candidates.sort(reverse=True)  # prefer yolov8m over yolov8s
        model = candidates[0] if candidates else ""
    
    log.info(f"Loading: {model}")
    hef = HEF(model)
    
    params = VDevice.create_params()
    params.scheduling_algorithm = HailoSchedulingAlgorithm.ROUND_ROBIN
    # Keep VDevice alive by storing as global
    global _vdevice
    _vdevice = VDevice(params)
    
    ng = _vdevice.configure(hef)[0]
    # Keep ng alive
    global _ng
    _ng = ng
    
    inp_p = InputVStreamParams.make(ng, quantized=False, format_type=FormatType.FLOAT32)
    out_p = OutputVStreamParams.make(ng, quantized=False, format_type=FormatType.FLOAT32)
    _input_name = hef.get_input_vstream_infos()[0].name
    
    log.info(f"Input: {_input_name}")
    log.info(f"Output: {[o.name for o in hef.get_output_vstream_infos()]}")
    
    # Create the InferVStreams wrapper and enter its context
    _ctx = InferVStreams(ng, inp_p, out_p)
    _pipeline = _ctx.__enter__()
    
    hailo_ready = True
    log.info("✅ Pipeline open — will stay active for process lifetime")


def run_inference(image_bytes: bytes) -> dict:
    """Synchronous inference using the persistent pipeline."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    orig_w, orig_h = img.size
    arr = np.expand_dims(np.array(img.resize((640, 640)), dtype=np.float32), 0)
    
    raw = _pipeline.infer({_input_name: arr})
    
    detections = []
    for _, v in raw.items():
        if not isinstance(v, list) or len(v) == 0:
            continue
        batch = v[0]
        if not isinstance(batch, (list, np.ndarray)) or len(batch) == 0:
            continue
        # Class 0 = person
        person_dets = batch[0]
        if not hasattr(person_dets, '__len__') or len(person_dets) == 0:
            continue
        pd = np.array(person_dets)
        if pd.ndim == 1 and len(pd) == 5:
            pd = pd.reshape(1, 5)
        elif pd.ndim != 2 or pd.shape[1] != 5:
            continue
        for row in pd:
            y1, x1, y2, x2, conf = row
            if conf < CONF:
                continue
            detections.append({
                "x1": round(float(x1) * orig_w, 1),
                "y1": round(float(y1) * orig_h, 1),
                "x2": round(float(x2) * orig_w, 1),
                "y2": round(float(y2) * orig_h, 1),
                "confidence": round(float(conf), 3),
                "class_id": 0
            })
    
    return {"detections": detections, "count": len(detections)}


async def health(request):
    return JSONResponse({"status": "ok", "hailo": hailo_ready})


async def infer(request):
    if not hailo_ready:
        return JSONResponse({"detections": [], "error": "warming up"}, status_code=503)
    
    body = await request.body()
    if not body:
        return JSONResponse({"detections": []}, status_code=400)
    
    try:
        async with _lock:
            t0 = time.monotonic()
            result = await asyncio.get_event_loop().run_in_executor(
                None, run_inference, body
            )
            ms = round((time.monotonic() - t0) * 1000, 1)
        
        result["inference_ms"] = ms
        log.info(f"{result['count']} persons in {ms}ms")
        return JSONResponse(result)
    except Exception as e:
        log.error(f"Error: {e}", exc_info=True)
        return JSONResponse({"detections": [], "error": str(e)}, status_code=500)


app = Starlette(routes=[
    Route("/health", health),
    Route("/infer", infer, methods=["POST"]),
])


if __name__ == "__main__":
    init_hailo()
    if not hailo_ready:
        log.error("Failed to start")
        sys.exit(1)
    uvicorn.run(app, host="0.0.0.0", port=PORT, workers=1)
