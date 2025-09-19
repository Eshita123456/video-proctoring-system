// backend/server.js
require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

// ✅ Serve static files from repo-root /public
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const LOGS_FILE = path.join(__dirname, 'logs.json');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ensure directories exist
for (const d of [PUBLIC_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Multer config
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    const allowed = ['video/webm', 'video/mp4', 'video/quicktime', 'application/octet-stream'];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(webm|mp4|mov|mkv)$/i)) return cb(null, true);
    cb(new Error('Unsupported file type'));
  }
});

// In-memory logs + persistence
let logs = [];
let mongoClient = null;
let db = null;

// load logs if present
(async () => {
  try {
    if (fs.existsSync(LOGS_FILE)) {
      const raw = await fsp.readFile(LOGS_FILE, 'utf8');
      logs = JSON.parse(raw || '[]');
    }
  } catch (err) {
    console.error('Failed to read logs file:', err.message);
    logs = [];
  }
})();

// Mongo init
async function initMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return;
  try {
    mongoClient = new MongoClient(uri, { useUnifiedTopology: true });
    await mongoClient.connect();
    db = mongoClient.db(process.env.MONGODB_DBNAME || 'proctoring');
    console.log('MongoDB connected');
  } catch (e) {
    console.error('MongoDB connection failed:', e.message);
    mongoClient = null;
    db = null;
  }
}
initMongo().catch(() => {});

// Helper: save logs
async function persistLogs() {
  try {
    await fsp.writeFile(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing logs file:', e.message);
  }
}

// ✅ Simple CSV generator (no dependency)
function generateCSV(records, columns) {
  const header = columns.join(',') + '\n';
  const rows = records.map(rec => {
    return columns.map(col => {
      let v = rec[col] == null ? '' : String(rec[col]);
      v = v.replace(/"/g, '""'); // escape quotes
      if (/[,"\n]/.test(v)) v = `"${v}"`; // quote if needed
      return v;
    }).join(',');
  }).join('\n');
  return header + rows;
}

// ====== APIs ======

// Save event log
app.post('/api/log', async (req, res) => {
  try {
    const entry = req.body;
    if (!entry || typeof entry !== 'object') return res.status(400).json({ error: 'invalid payload' });
    entry.receivedAt = new Date().toISOString();
    logs.push(entry);

    persistLogs();

    if (db) {
      try {
        await db.collection('events').insertOne(entry);
      } catch (err) {
        console.error('Mongo insert failed:', err.message);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/log error:', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// Upload video
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  const safeName = `${Date.now()}-${path.basename(req.file.originalname).replace(/\s+/g, '_')}`;
  const ext = path.extname(req.file.originalname) || '.webm';
  const dest = path.join(UPLOADS_DIR, safeName + ext);

  try {
    await fsp.rename(req.file.path, dest);
    return res.json({ ok: true, path: `/uploads/${path.basename(dest)}`, filename: path.basename(dest) });
  } catch (err) {
    try { await fsp.unlink(req.file.path); } catch (_) {}
    console.error('File save failed:', err.message);
    return res.status(500).json({ error: 'file save failed' });
  }
});

// Serve uploaded videos
app.use('/uploads', express.static(UPLOADS_DIR));

// Return logs
app.get('/api/logs', (req, res) => {
  const n = Math.min(1000, parseInt(req.query.n || '100', 10));
  res.json(logs.slice(-n));
});

// Generate CSV report
app.get('/api/report', (req, res) => {
  try {
    const records = logs.map(l => ({
      Timestamp: l.timestamp || l.receivedAt || '',
      Event: l.type || '',
      Detail: JSON.stringify(l.detail || l)
    }));

    const columns = ['Timestamp', 'Event', 'Detail'];
    const csv = generateCSV(records, columns);

    res.setHeader('Content-Disposition', `attachment; filename="proctoring_report_${Date.now()}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(csv);
  } catch (err) {
    console.error('CSV generation failed:', err.message);
    return res.status(500).json({ error: 'report generation failed' });
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve frontend static and fallback
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return res.status(200).send('Server is running. No frontend found.');
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  try {
    if (mongoClient) await mongoClient.close();
  } catch (e) { console.error('Error closing mongo:', e.message); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
