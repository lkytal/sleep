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

const DATA_FILE = path.join(__dirname, '..', 'data', 'sleep_data.json');
const CONFIG_DIR = path.join(__dirname, '..', 'config');

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readData() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}

function writeData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

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

// ---- Data CRUD ----
app.get('/api/records', (req, res) => {
  res.json(readData());
});

app.put('/api/records/:date', (req, res) => {
  const data = readData();
  const record = req.body;
  if (!record || !record.date) return res.status(400).json({ error: 'Invalid record' });
  data[record.date] = record;
  writeData(data);
  res.json({ ok: true });
});

app.delete('/api/records/:date', (req, res) => {
  const data = readData();
  delete data[req.params.date];
  writeData(data);
  res.json({ ok: true });
});

app.post('/api/records/import', (req, res) => {
  const imported = req.body;
  if (!imported || typeof imported !== 'object') return res.status(400).json({ error: 'Invalid data' });
  const data = readData();
  const merged = { ...data, ...imported };
  writeData(merged);
  res.json({ ok: true, count: Object.keys(imported).length });
});

// ---- Config ----
app.get('/api/config/medications', (req, res) => res.json(readConfig('medications.csv')));
app.get('/api/config/tags', (req, res) => res.json(readConfig('tags.csv')));
app.get('/api/config/events', (req, res) => res.json(readConfig('events.csv')));

// ---- Analysis ----
app.post('/api/analysis', (req, res) => {
  const { windowDays, activeGroups, predictionTarget, useWeekdayRandomIntercept } = req.body;
  const allMeds = readConfig('medications.csv');
  const allEvents = readConfig('events.csv');
  let records = Object.values(readData()).sort((a, b) => a.date.localeCompare(b.date));
  if (windowDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    records = records.filter(r => r.date >= cutoffStr);
  }
  const result = runAnalysis({ records, activeGroups, predictionTarget, useWeekdayRandomIntercept, allMeds, allEvents });
  if (result.error) return res.status(422).json(result);
  res.json(result);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Sleep tracker backend running on http://localhost:${PORT}`));
