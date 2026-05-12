'use strict';
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { runAnalysis } = require('./analysis');

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..')));

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONFIG_DIR = path.join(__dirname, '..', 'config');

// Legacy data file (for migration)
const LEGACY_DATA_FILE = path.join(DATA_DIR, 'sleep_data.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- User management ----
function readUsers() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}

function writeUsers(users) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function getUserDataFile(userId) {
  return path.join(DATA_DIR, userId, 'sleep_data.json');
}

// ---- Per-user data ----
function readData(userId) {
  const file = getUserDataFile(userId);
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeData(userId, data) {
  const file = getUserDataFile(userId);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---- Migrate legacy data ----
// If the old flat sleep_data.json exists and no users exist yet,
// create a "default" user and move the data into their directory.
function migrateLegacy() {
  if (fs.existsSync(LEGACY_DATA_FILE)) {
    const users = readUsers();
    if (users.length === 0) {
      const defaultId = 'default';
      const defaultUser = { id: defaultId, name: '默认用户', createdAt: new Date().toISOString() };
      writeUsers([defaultUser]);
      try {
        const oldData = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8'));
        writeData(defaultId, oldData);
      } catch { /* ignore bad legacy data */ }
      // Remove old file so migration doesn't re-run
      fs.renameSync(LEGACY_DATA_FILE, LEGACY_DATA_FILE + '.bak');
      console.log('Migrated legacy sleep_data.json → data/default/sleep_data.json');
    }
  }
}
migrateLegacy();

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj = {};
    header.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

function readConfig(name) {
  const file = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(file)) return [];
  try { return parseCSV(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

// ---- User CRUD ----
app.get('/api/users', (req, res) => {
  res.json(readUsers());
});

app.post('/api/users', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const users = readUsers();
  // Generate a URL-safe id from the name
  const id = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '_').replace(/_+/g, '_') + '_' + Date.now().toString(36);
  const user = { id, name: name.trim(), createdAt: new Date().toISOString() };
  users.push(user);
  writeUsers(users);
  // Create user data directory
  ensureDir(path.join(DATA_DIR, id));
  res.json(user);
});

app.delete('/api/users/:id', (req, res) => {
  let users = readUsers();
  const userId = req.params.id;
  users = users.filter(u => u.id !== userId);
  writeUsers(users);
  // Optionally remove user data directory
  const userDir = path.join(DATA_DIR, userId);
  if (fs.existsSync(userDir)) {
    fs.rmSync(userDir, { recursive: true, force: true });
  }
  res.json({ ok: true });
});

// ---- Data CRUD (scoped to user) ----
app.get('/api/records', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json(readData(userId));
});

app.put('/api/records/:date', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const data = readData(userId);
  const record = req.body;
  if (!record || !record.date) return res.status(400).json({ error: 'Invalid record' });
  data[record.date] = record;
  writeData(userId, data);
  res.json({ ok: true });
});

app.delete('/api/records/:date', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const data = readData(userId);
  delete data[req.params.date];
  writeData(userId, data);
  res.json({ ok: true });
});

app.post('/api/records/import', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const imported = req.body;
  if (!imported || typeof imported !== 'object') return res.status(400).json({ error: 'Invalid data' });
  const data = readData(userId);
  const merged = { ...data, ...imported };
  writeData(userId, merged);
  res.json({ ok: true, count: Object.keys(imported).length });
});

// ---- Config ----
app.get('/api/config/medications', (req, res) => res.json(readConfig('medications.csv')));
app.get('/api/config/tags', (req, res) => res.json(readConfig('tags.csv')));
app.get('/api/config/events', (req, res) => res.json(readConfig('events.csv')));

// ---- Analysis ----
app.post('/api/analysis', (req, res) => {
  const { userId, windowDays, startDate, activeGroups, predictionTarget, useWeekdayRandomIntercept, includeOutliers } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const allMeds = readConfig('medications.csv');
  const allEvents = readConfig('events.csv');
  let records = Object.values(readData(userId)).sort((a, b) => a.date.localeCompare(b.date));
  
  if (startDate) {
    records = records.filter(r => r.date >= startDate);
  } else if (windowDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    records = records.filter(r => r.date >= cutoffStr);
  }
  // Filter out outlier records unless explicitly included
  if (!includeOutliers) {
    records = records.filter(r => !r.isOutlier);
  }
  const result = runAnalysis({ records, activeGroups, predictionTarget, useWeekdayRandomIntercept, allMeds, allEvents });
  if (result.error) return res.status(422).json(result);
  res.json(result);
});

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Sleep tracker backend running on all interfaces at port ${PORT}`));
