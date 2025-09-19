/* public/app.js
   Full client-side proctoring frontend:
   - Focus detection: looking_away (>5s), no_face (>10s), multiple_faces
   - Item detection: COCO-SSD (phones, books, laptop) + paper heuristic
   - Logs events to UI and /api/log
   - Records webcam, uploads to /api/upload-video
   - Generates Proctoring Report (JSON/CSV/PDF) on session end
   Notes:
     - Requires index.html to include TF.js, blazeface and coco-ssd scripts before this file:
       <script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js"></script>
       <script src="https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.0.7/dist/blazeface.min.js"></script>
       <script src="https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js"></script>
*/

const BACKEND = 'cpu'; // 'cpu' or 'webgl'
const FACE_LOOK_AWAY_MS = 5000;
const NO_FACE_MS = 10000;
const ITEM_DETECTION_CONFIDENCE = 0.45;
const ITEM_DEBOUNCE_MS = 5000; // debounce per item type

const ITEM_CLASSES = new Set([
  'cell phone', 'cellphone', 'phone',
  'laptop', 'book', 'remote',
  'keyboard', 'mouse', 'tv', 'monitor'
]);

// UI elements
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
ctx.font = '14px sans-serif';

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');
const eventsList = document.getElementById('events');
const candidateNameInput = document.getElementById('candidateName');

// Models & media
let faceModel = null;
let objModel = null;
let stream = null;
let recorder = null;
let recordedChunks = [];

// State / session
let session = {
  name: '',
  startedAt: null,
  endedAt: null,
  durationMs: 0,
  lookingAwayCount: 0,
  noFaceCount: 0,
  multipleFacesCount: 0,
  objectDetectedCount: 0
};

let eventHistory = []; // recent events for report
let lastItemLogAt = {}; // debounce per item reason

let noFaceSince = null;
let lookingAwaySince = null;

// UI status helper
function uiStatus(msg) {
  if (status) status.textContent = msg;
  console.log('[STATUS]', msg);
}

// Logging utility (UI + backend)
async function postLog(type, detail = {}) {
  const entry = { timestamp: new Date().toISOString(), type, detail };
  // UI
  const li = document.createElement('li');
  li.textContent = `[${entry.timestamp}] ${type} — ${JSON.stringify(detail)}`;
  eventsList.prepend(li);
  // in-memory history (for report)
  eventHistory.unshift(entry);

  // counters
  if (type === 'looking_away') session.lookingAwayCount++;
  if (type === 'no_face') session.noFaceCount++;
  if (type === 'multiple_faces') session.multipleFacesCount++;
  if (type === 'object_detected') session.objectDetectedCount++;

  // send to backend (best-effort)
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
  } catch (e) {
    console.warn('postLog: failed to send to /api/log', e);
  }
}

// Integrity scoring
function computeIntegrityScore(s) {
  const deductions =
    (s.lookingAwayCount * 6) +
    (s.noFaceCount * 12) +
    (s.multipleFacesCount * 20) +
    (s.objectDetectedCount * 3);
  return Math.max(0, 100 - deductions);
}

// Humanize ms
function msToHuman(ms) {
  if (!isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (hh ? hh + 'h ' : '') + (mm ? mm + 'm ' : '') + ss + 's';
}

// Paper/notes heuristic: bright-white region test
function detectPaperHeuristic(x, y, w, h) {
  try {
    const sx = Math.max(0, Math.round(x));
    const sy = Math.max(0, Math.round(y));
    const sw = Math.min(ctx.canvas.width - sx, Math.max(1, Math.round(w)));
    const sh = Math.min(ctx.canvas.height - sy, Math.max(1, Math.round(h)));
    if (sw <= 0 || sh <= 0) return false;
    const img = ctx.getImageData(sx, sy, sw, sh);
    let whitePixels = 0;
    const total = img.data.length / 4;
    // sample at a stride to reduce cost if region large
    const stride = Math.max(1, Math.floor(total / 2000)); // aim ~2000 samples max
    for (let i = 0; i < img.data.length; i += 4 * stride) {
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lum > 0.85) whitePixels++;
    }
    const sampled = Math.ceil(total / stride);
    return (whitePixels / sampled) > 0.30;
  } catch (e) {
    console.warn('detectPaperHeuristic failed', e);
    return false;
  }
}

// Dynamic jsPDF loader
async function ensureJsPdf() {
  if (window.jspdf && (window.jspdf.jsPDF || window.jspdf.default)) {
    return window.jspdf.jsPDF || window.jspdf.default.jsPDF;
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = () => {
      const js = window.jspdf && (window.jspdf.jsPDF || (window.jspdf.default && window.jspdf.default.jsPDF));
      if (js) resolve(js);
      else reject(new Error('jsPDF not available after load'));
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// Build report object
function buildReport() {
  const integrityScore = computeIntegrityScore(session);
  return {
    candidateName: session.name || 'Unknown',
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: session.durationMs,
    durationHuman: msToHuman(session.durationMs),
    lookingAwayCount: session.lookingAwayCount,
    noFaceCount: session.noFaceCount,
    multipleFacesCount: session.multipleFacesCount,
    objectDetectedCount: session.objectDetectedCount,
    integrityScore,
    events: eventHistory.slice(0, 1000)
  };
}

// Download helpers
function downloadJSON(report) {
  const data = JSON.stringify(report, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(report.candidateName || 'candidate').replace(/\s+/g, '_')}_proctoring_report.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadCSV(report) {
  const rows = [];
  rows.push(['Candidate Name', report.candidateName]);
  rows.push(['Started At', report.startedAt]);
  rows.push(['Ended At', report.endedAt]);
  rows.push(['Duration (ms)', report.durationMs]);
  rows.push(['Duration', report.durationHuman]);
  rows.push(['Looking Away Count', report.lookingAwayCount]);
  rows.push(['No Face Count', report.noFaceCount]);
  rows.push(['Multiple Faces Count', report.multipleFacesCount]);
  rows.push(['Object Detected Count', report.objectDetectedCount]);
  rows.push(['Integrity Score', report.integrityScore]);
  rows.push([]);
  rows.push(['Event Timestamp', 'Type', 'Detail JSON']);
  for (const ev of (report.events || [])) {
    rows.push([ev.timestamp, ev.type, JSON.stringify(ev.detail)]);
  }
  const csv = rows.map(r => r.map(cell => {
    if (cell === null || cell === undefined) return '';
    const s = String(cell).replace(/"/g, '""');
    if (s.includes(',') || s.includes('\n') || s.includes('"')) return `"${s}"`;
    return s;
  }).join(',')).join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(report.candidateName || 'candidate').replace(/\s+/g, '_')}_proctoring_report.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function downloadPDF(report) {
  try {
    const jsPDFCtor = await ensureJsPdf();
    const doc = new jsPDFCtor({ unit: 'pt', format: 'a4' });
    let y = 40;
    const margin = 40;
    doc.setFontSize(18);
    doc.text('Proctoring Report', margin, y);
    doc.setFontSize(11);
    y += 26;
    doc.text(`Candidate: ${report.candidateName}`, margin, y); y += 14;
    doc.text(`Started: ${report.startedAt}`, margin, y); y += 12;
    doc.text(`Ended: ${report.endedAt}`, margin, y); y += 12;
    doc.text(`Duration: ${report.durationHuman} (${report.durationMs} ms)`, margin, y); y += 14;
    doc.text(`Looking-away events: ${report.lookingAwayCount}`, margin, y); y += 12;
    doc.text(`No-face events: ${report.noFaceCount}`, margin, y); y += 12;
    doc.text(`Multiple faces events: ${report.multipleFacesCount}`, margin, y); y += 12;
    doc.text(`Object-detected events: ${report.objectDetectedCount}`, margin, y); y += 16;
    doc.setFontSize(13);
    doc.text(`Integrity Score: ${report.integrityScore}`, margin, y); y += 18;
    doc.setFontSize(10);
    doc.text('Recent Events (most recent first):', margin, y); y += 14;
    const maxLines = 30;
    let count = 0;
    for (const ev of (report.events || [])) {
      if (count >= maxLines) {
        doc.text(`...and ${report.events.length - maxLines} more`, margin, y);
        y += 12;
        break;
      }
      const line = `${ev.timestamp} — ${ev.type} — ${JSON.stringify(ev.detail)}`;
      const split = doc.splitTextToSize(line, 520);
      doc.text(split, margin, y);
      y += split.length * 12;
      if (y > 750) { doc.addPage(); y = 40; }
      count++;
    }
    const filename = `${(report.candidateName || 'candidate').replace(/\s+/g, '_')}_proctoring_report.pdf`;
    doc.save(filename);
  } catch (e) {
    console.error('downloadPDF failed', e);
    alert('PDF generation failed (see console).');
  }
}

function injectReportDownloads(report) {
  const existing = document.getElementById('report-downloads');
  if (existing) existing.remove();
  const container = document.createElement('div');
  container.id = 'report-downloads';
  container.style.margin = '8px 0';
  container.style.display = 'flex';
  container.style.gap = '8px';
  const pdfBtn = document.createElement('button');
  pdfBtn.type = 'button'; pdfBtn.textContent = 'Download PDF'; pdfBtn.onclick = () => downloadPDF(report);
  const csvBtn = document.createElement('button');
  csvBtn.type = 'button'; csvBtn.textContent = 'Download CSV'; csvBtn.onclick = () => downloadCSV(report);
  const jsonBtn = document.createElement('button');
  jsonBtn.type = 'button'; jsonBtn.textContent = 'Download JSON'; jsonBtn.onclick = () => downloadJSON(report);
  container.appendChild(pdfBtn); container.appendChild(csvBtn); container.appendChild(jsonBtn);
  const parent = eventsList.parentElement || document.body;
  parent.insertBefore(container, eventsList);
}

// Models init (CPU-first)
async function initModels() {
  uiStatus('Initializing TF backend & models...');
  if (typeof tf === 'undefined') {
    uiStatus('ERROR: TensorFlow.js not found. Include tf.min.js before app.js');
    throw new Error('tf not loaded');
  }
  await tf.ready();
  try {
    await tf.setBackend(BACKEND);
    await tf.ready();
    console.log('TF backend set to', BACKEND);
  } catch (e) {
    console.warn('failed to set backend', BACKEND, e);
    await tf.setBackend('cpu');
    await tf.ready();
    console.log('TF backend fallback to cpu');
  }

  uiStatus('Loading BlazeFace...');
  try {
    faceModel = await blazeface.load();
    console.log('BlazeFace loaded');
  } catch (e) {
    faceModel = null;
    console.warn('BlazeFace load failed', e);
    uiStatus('Warning: BlazeFace failed to load');
  }

  uiStatus('Loading COCO-SSD (object detector)...');
  try {
    objModel = await cocoSsd.load();
    console.log('COCO-SSD loaded');
  } catch (e) {
    objModel = null;
    console.warn('COCO-SSD load failed', e);
    uiStatus('Warning: COCO-SSD failed to load (object detection disabled)');
  }

  uiStatus(`Models ready. face:${!!faceModel} obj:${!!objModel}`);
}

// Start session
async function startSession() {
  session.name = candidateNameInput.value || 'Unknown';
  session.startedAt = new Date().toISOString();
  session.endedAt = null;
  session.durationMs = 0;
  session.lookingAwayCount = session.noFaceCount = session.multipleFacesCount = session.objectDetectedCount = 0;
  eventHistory = []; lastItemLogAt = {};
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();
    overlay.width = video.videoWidth || 640; overlay.height = video.videoHeight || 480;

    recordedChunks = [];
    let mime = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = 'video/webm;codecs=vp8';
      if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
    }
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch (e) {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    recorder.start(1000);

    startBtn.disabled = true; stopBtn.disabled = false;
    uiStatus('Session started');
    await postLog('session_start', { candidate: session.name });

    noFaceSince = null; lookingAwaySince = null;
    detectionLoop();
  } catch (e) {
    console.error('startSession failed', e);
    uiStatus('Camera error: ' + (e && e.message ? e.message : e));
  }
}

// Stop session
async function stopSession() {
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) { console.warn(e); }
  if (stream) stream.getTracks().forEach(t => t.stop());
  startBtn.disabled = false; stopBtn.disabled = true;
  session.endedAt = new Date().toISOString();
  session.durationMs = new Date(session.endedAt) - new Date(session.startedAt || session.endedAt);
  const report = buildReport();
  // show in UI
  const li = document.createElement('li');
  li.textContent = `[${new Date().toISOString()}] session_report — ${JSON.stringify(report)}`;
  eventsList.prepend(li);
  // send to backend
  try {
    await fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_report', detail: report }) });
  } catch (e) {
    console.warn('report upload failed', e);
  }
  uiStatus(`Stopped. Integrity score: ${report.integrityScore}`);
  injectReportDownloads(report);

  // upload recorded video (best-effort)
  try {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const form = new FormData();
    form.append('video', blob, `${(session.name || 'candidate').replace(/\s+/g,'_')}.webm`);
    const resp = await fetch('/api/upload-video', { method: 'POST', body: form });
    if (resp.ok) console.log('Video uploaded');
    else console.warn('Video upload non-OK', resp.status);
  } catch (e) {
    console.warn('Video upload failed', e);
  }
}

// Detection loop
async function detectionLoop() {
  // wait up to a short time for models to load (non blocking)
  const waitForModels = async (maxMs = 8000) => {
    const start = Date.now();
    while (!faceModel && !objModel && (Date.now() - start) < maxMs) {
      console.log('Waiting for any model to load...');
      await new Promise(r => setTimeout(r, 400));
    }
  };
  await waitForModels();
  if (!faceModel && !objModel) {
    uiStatus('No models loaded; detection disabled.');
    return;
  }

  const TICK = 500;
  let lastObjTick = Date.now();

  async function tick() {
    if (!video || video.paused || video.ended) { requestAnimationFrame(tick); return; }
    const now = Date.now();
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Face detection
    let faces = [];
    if (faceModel) {
      try {
        faces = await faceModel.estimateFaces(video, false);
      } catch (e) {
        console.warn('faceModel estimateFaces error', e);
        faces = [];
      }
    }

    if (!faces || faces.length === 0) {
      if (!noFaceSince) noFaceSince = now;
      else if (now - noFaceSince > NO_FACE_MS) {
        await postLog('no_face', { duration_ms: now - noFaceSince });
        noFaceSince = now + 1000;
      }
      lookingAwaySince = null;
    } else {
      noFaceSince = null;
      if (faces.length > 1) await postLog('multiple_faces', { count: faces.length });

      for (const f of faces) {
        try {
          // Normalize bounding box formats
          let start = null, end = null;
          if (Array.isArray(f.topLeft) && Array.isArray(f.bottomRight)) {
            start = f.topLeft; end = f.bottomRight;
          } else if (Array.isArray(f.boundingBox) && f.boundingBox.length >= 4) {
            start = [f.boundingBox[0], f.boundingBox[1]];
            end = [f.boundingBox[0] + f.boundingBox[2], f.boundingBox[1] + f.boundingBox[3]];
          } else if (Array.isArray(f.box) && f.box.length >= 4) {
            start = [f.box[0], f.box[1]];
            end = [f.box[0] + f.box[2], f.box[1] + f.box[3]];
          } else if (f.topLeft && Array.isArray(f.topLeft) && Array.isArray(f.topLeft[0])) {
            start = f.topLeft[0];
            end = (f.bottomRight && Array.isArray(f.bottomRight) && Array.isArray(f.bottomRight[0])) ? f.bottomRight[0] : null;
          }

          if (!start || !end) {
            console.warn('Unexpected face format, skipping', f);
            continue;
          }

          const x = Number(start[0]), y = Number(start[1]);
          const w = Number(end[0]) - Number(start[0]);
          const h = Number(end[1]) - Number(start[1]);
          if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) {
            console.warn('Invalid bbox, skip', { x, y, w, h });
            continue;
          }

          ctx.strokeStyle = 'lime'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);

          const centerX = x + w / 2, centerY = y + h / 2;
          const dx = Math.abs(centerX - overlay.width / 2), dy = Math.abs(centerY - overlay.height / 2);
          const norm = Math.sqrt(dx * dx + dy * dy);

          if (norm > overlay.width * 0.18) {
            if (!lookingAwaySince) lookingAwaySince = now;
            else if (now - lookingAwaySince > FACE_LOOK_AWAY_MS) {
              await postLog('looking_away', { duration_ms: now - lookingAwaySince });
              lookingAwaySince = now + 1000;
            }
          } else {
            lookingAwaySince = null;
          }
        } catch (e) {
          console.warn('Error processing face entry', e, f);
        }
      } // faces
    }

    // Object detection (periodic)
    if (objModel && (now - lastObjTick) >= TICK * 2) {
      lastObjTick = now;
      try {
        const objs = await objModel.detect(video);
        for (const o of objs) {
          try {
            const [ox, oy, ow, oh] = o.bbox;
            ctx.strokeStyle = 'yellow'; ctx.lineWidth = 2; ctx.strokeRect(ox, oy, ow, oh);
            ctx.fillStyle = 'yellow'; ctx.fillText(`${o.class} ${Math.round(o.score * 100)}%`, ox + 4, oy + 12);

            const cls = String(o.class).toLowerCase();
            const score = Number(o.score || 0);
            let flagged = false;
            let reason = '';

            if (ITEM_CLASSES.has(cls) && score >= ITEM_DETECTION_CONFIDENCE) {
              flagged = true; reason = cls;
            } else if (score >= 0.25) {
              // heuristic: paper detection
              if (detectPaperHeuristic(ox, oy, ow, oh)) {
                flagged = true; reason = 'paper/note (heuristic)';
              }
            }

            if (flagged) {
              const nowTs = Date.now();
              const last = lastItemLogAt[reason] || 0;
              if (nowTs - last > ITEM_DEBOUNCE_MS) {
                lastItemLogAt[reason] = nowTs;
                await postLog('object_detected', { object: reason, model_class: o.class, score: score.toFixed(2), bbox: o.bbox });
              }
            }
          } catch (inner) {
            console.warn('Error handling object', inner, o);
          }
        }
      } catch (e) {
        console.warn('objModel.detect error', e);
      }
    }

    requestAnimationFrame(tick);
  } // tick

  tick();
}

// Wiring
startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', stopSession);
window.addEventListener('load', () => {
  uiStatus('Ready — loading models in background...');
  initModels().catch(e => { console.error('initModels failed', e); uiStatus('Model init error (see console)'); });
});
