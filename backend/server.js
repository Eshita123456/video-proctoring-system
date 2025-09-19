/**
 * Simple Express server that serves the frontend and provides APIs for:
 * - /api/log  : POST event logs (JSON)
 * - /api/upload-video : POST video file (multipart/form-data)
 * - /api/report : GET generated sample CSV report
 *
 * Supports MongoDB if MONGODB_URI is provided; otherwise falls back to local logs file.
 */
require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fs = require('fs');
const path = require('path');
const {MongoClient} = require('mongodb');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const app = express();
const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// In-memory cache / fallback storage
let logs = [];
let mongoClient = null;
let db = null;
const LOGS_FILE = path.join(__dirname, 'logs.json');

async function initMongo() {
  if (process.env.MONGODB_URI) {
    try {
      mongoClient = new MongoClient(process.env.MONGODB_URI);
      await mongoClient.connect();
      db = mongoClient.db(process.env.MONGODB_DBNAME || 'proctoring');
      console.log('MongoDB connected');
    } catch (e) {
      console.error('MongoDB connection failed:', e.message);
    }
  }
}

// load logs file if exists
if (fs.existsSync(LOGS_FILE)) {
  try { logs = JSON.parse(fs.readFileSync(LOGS_FILE)); } catch(e){ logs = []; }
}

app.post('/api/log', async (req, res) => {
  const entry = req.body;
  entry.receivedAt = new Date().toISOString();
  logs.push(entry);
  // save to file
  try { fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2)); } catch(e){ console.error(e); }
  // save to mongo if available
  if (db) {
    try {
      await db.collection('events').insertOne(entry);
    } catch(e){ console.error('mongo insert failed', e.message); }
  }
  res.json({ ok: true });
});

app.post('/api/upload-video', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const dest = path.join(__dirname, 'uploads', req.file.originalname + '-' + Date.now() + '.webm');
  fs.renameSync(req.file.path, dest);
  res.json({ ok: true, path: dest });
});

app.get('/api/logs', async (req, res) => {
  // return last 100 logs
  res.json(logs.slice(-100));
});

app.get('/api/report', async (req, res) => {
  // create a simple CSV report from logs
  const csvPath = path.join(__dirname, 'proctoring_report.csv');
  const csvWriter = createCsvWriter({
    path: csvPath,
    header: [
      {id: 'timestamp', title: 'Timestamp'},
      {id: 'type', title: 'Event'},
      {id: 'detail', title: 'Detail'}
    ]
  });
  const records = logs.map(l => ({
    timestamp: l.timestamp || l.receivedAt || '',
    type: l.type || '',
    detail: JSON.stringify(l.detail || l)
  }));
  await csvWriter.writeRecords(records);
  res.download(csvPath);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

initMongo().catch(()=>{});
app.listen(PORT, ()=>console.log('Server running on port', PORT));