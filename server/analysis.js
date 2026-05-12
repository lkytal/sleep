'use strict';
const { fitOrdinalMixed, fitLinearRegression } = require('./modelFit');
const { sigmoid } = require('./mathUtils');

// ---- Data helpers ----
function timeToMinutes(time) {
  if (!time) return NaN;
  return time.hour * 60 + time.minute;
}
function circularMinuteDiff(v, c) {
  let d = v - c;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}
function circularMeanMinutes(values) {
  if (!values.length) return 0;
  let sinSum = 0, cosSum = 0;
  values.forEach(m => { const r = (m / 1440) * 2 * Math.PI; sinSum += Math.sin(r); cosSum += Math.cos(r); });
  const angle = Math.atan2(sinSum / values.length, cosSum / values.length);
  return ((angle < 0 ? angle + 2 * Math.PI : angle) / (2 * Math.PI)) * 1440;
}
function medicationOffsetHours(med, record) {
  const m = timeToMinutes(med.time), b = timeToMinutes(record.bedtime);
  if (!Number.isFinite(m) || !Number.isFinite(b)) return NaN;
  return circularMinuteDiff(m, b) / 60;
}
function parseDoseValue(s) {
  if (!s) return null;
  const m = String(s).match(/^([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}
function computeMedTimeStats(records, medIds) {
  const acc = {}; medIds.forEach(id => { acc[id] = []; });
  records.forEach(r => (r.medications || []).forEach(m => { if (acc[m.id]) { const oh = medicationOffsetHours(m, r); if (Number.isFinite(oh)) acc[m.id].push(oh); } }));
  const res = {};
  medIds.forEach(id => { const v = acc[id]; if (!v.length) { res[id] = null; return; } const mean = v.reduce((s, x) => s + x, 0) / v.length; const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(v.length - 1, 1)) || 1; res[id] = { mean, sd }; });
  return res;
}
function computeMedMeanDose(records, medIds) {
  const acc = {}; medIds.forEach(id => { acc[id] = []; });
  records.forEach(r => (r.medications || []).forEach(m => { if (acc[m.id]) { const dv = parseDoseValue(m.dose); if (dv !== null) acc[m.id].push(dv); } }));
  const res = {};
  medIds.forEach(id => { const v = acc[id]; if (!v.length) { res[id] = null; return; } const mean = v.reduce((s, x) => s + x, 0) / v.length; const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(v.length - 1, 1)) || 1; res[id] = { mean, sd }; });
  return res;
}
function computeBioStats(records) {
  const hvArr = [], rArr = [], dArr = [];
  records.forEach(r => { const bio = r.biometrics || {}; if (bio.hrv != null) hvArr.push(bio.hrv); if (bio.rhr != null) rArr.push(bio.rhr); if (bio.deepSleepPct != null) dArr.push(bio.deepSleepPct); });
  const stat = v => { if (!v.length) return { mean: 0, sd: 1, count: 0 }; const mean = v.reduce((s, x) => s + x, 0) / v.length; const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(v.length - 1, 1)) || 1; return { mean, sd, count: v.length }; };
  return { hrv: stat(hvArr), rhr: stat(rArr), deep: stat(dArr) };
}

const PRED_TARGETS = {
  score: { label: '睡眠分数', type: 'ordinal', unit: '分', getValue: r => r.score },
  hrv: { label: 'HRV', type: 'continuous', unit: 'ms', getValue: r => (r.biometrics || {}).hrv },
  deepSleepPct: { label: '深睡比例', type: 'continuous', unit: '%', getValue: r => (r.biometrics || {}).deepSleepPct },
  rhr: { label: '静息心率', type: 'continuous', unit: 'bpm', getValue: r => (r.biometrics || {}).rhr },
  effectiveSleep: { label: '睡眠时长', type: 'continuous', unit: '小时', getValue: r => r.effectiveSleep },
};

function runAnalysis({ records, activeGroups, predictionTarget, useWeekdayRandomIntercept, allMeds, allEvents }) {
  const target = PRED_TARGETS[predictionTarget];
  if (!target) return { error: '未知预测目标' };
  if (!activeGroups.length) return { error: '请至少勾选一个指标组' };
  if (records.length < 5) return { error: '至少需要 5 条记录才能进行回归分析' };

  const medIds = allMeds.map(m => m.id);
  const eventIds = allEvents.map(e => e.id);
  const has = k => activeGroups.includes(k);
  const needsPrev = has('sleepTime');
  const needsBio = has('bioMetrics');
  const includeHrv = predictionTarget !== 'hrv';
  const includeRhr = predictionTarget !== 'rhr';
  const includeDeep = predictionTarget !== 'deepSleepPct';

  const medTimeStats = computeMedTimeStats(records, medIds);
  const medMeanDose = computeMedMeanDose(records, medIds);
  let bioStats = { hrv: { count: 0 }, rhr: { count: 0 }, deep: { count: 0 } };
  if (needsBio) bioStats = computeBioStats(records);

  let meanSleep = 0, sdSleep = 1, meanBed = 0, sdBed = 1;
  if (needsPrev) {
    let s1 = 0; records.forEach(r => { s1 += r.effectiveSleep; }); meanSleep = s1 / records.length;
    let s2 = 0; records.forEach(r => { s2 += (r.effectiveSleep - meanSleep) ** 2; }); sdSleep = Math.sqrt(s2 / Math.max(records.length - 1, 1)) || 1;
    const bedMin = records.map(r => timeToMinutes(r.bedtime));
    meanBed = circularMeanMinutes(bedMin);
    let b2 = 0; records.forEach(r => { b2 += circularMinuteDiff(timeToMinutes(r.bedtime), meanBed) ** 2; }); sdBed = Math.sqrt(b2 / Math.max(records.length - 1, 1)) || 1;
  }

  const featureNames = [], featureTypes = [];
  if (has('medTaken')) medIds.forEach(id => { featureNames.push(`${(allMeds.find(m => m.id === id) || {}).name || id} 服用`); featureTypes.push('taken'); });
  if (has('medTime')) medIds.forEach(id => { featureNames.push(`${(allMeds.find(m => m.id === id) || {}).name || id} 相对入睡时间`); featureTypes.push('offset'); });
  if (has('medDose')) medIds.forEach(id => { featureNames.push(`${(allMeds.find(m => m.id === id) || {}).name || id} 剂量`); featureTypes.push('dose'); });
  if (has('events')) eventIds.forEach(id => { featureNames.push((allEvents.find(e => e.id === id) || {}).name || id); featureTypes.push('event'); });
  if (has('sleepTime')) { featureNames.push('绝对入睡时间', '前日有效睡眠', '前日睡眠评分'); featureTypes.push('sleep', 'sleep', 'sleep'); }
  if (has('bioMetrics')) {
    if (includeHrv && bioStats.hrv.count > 0) { featureNames.push('HRV'); featureTypes.push('bio'); }
    if (includeRhr && bioStats.rhr.count > 0) { featureNames.push('静息心率'); featureTypes.push('bio'); }
    if (includeDeep && bioStats.deep.count > 0) { featureNames.push('深睡比例'); featureTypes.push('bio'); }
  }
  if (!featureNames.length) return { error: '当前预测目标已从回归内容中移除，请再勾选其他指标组' };

  const dateMap = {};
  records.forEach(r => { dateMap[r.date] = r; });
  const X = [], Yarr = [], groups = [], dates = [];
  for (const r of records) {
    let prevRecord = null;
    if (needsPrev) {
      const pd = new Date(r.date); pd.setDate(pd.getDate() - 1);
      prevRecord = dateMap[pd.toISOString().slice(0, 10)];
      if (!prevRecord) continue;
    }
    const yVal = Number(target.getValue(r));
    if (!Number.isFinite(yVal)) continue;
    const row = [];
    const medMap = {};
    (r.medications || []).forEach(m => { medMap[m.id] = m; });
    if (has('medTaken')) medIds.forEach(id => row.push(medMap[id] ? 1 : 0));
    if (has('medTime')) medIds.forEach(id => { const med = medMap[id]; if (med && medTimeStats[id]) { const oh = medicationOffsetHours(med, r); row.push(Number.isFinite(oh) ? (oh - medTimeStats[id].mean) / medTimeStats[id].sd : 0); } else row.push(0); });
    if (has('medDose')) medIds.forEach(id => { const med = medMap[id]; if (med && med.dose && medMeanDose[id]) { const dv = parseDoseValue(med.dose); row.push(dv !== null ? (dv - medMeanDose[id].mean) / (medMeanDose[id].sd || 1) : 0); } else row.push(0); });
    if (has('events')) { const evSet = new Set(r.events || []); eventIds.forEach(id => row.push(evSet.has(id) ? 1 : 0)); }
    if (has('sleepTime')) { row.push(circularMinuteDiff(timeToMinutes(r.bedtime), meanBed) / sdBed); row.push((prevRecord.effectiveSleep - meanSleep) / sdSleep); row.push(prevRecord.score / 5 - 1); }
    if (has('bioMetrics')) {
      const bio = r.biometrics || {};
      if (includeHrv && bioStats.hrv.count > 0) row.push(bio.hrv != null ? (bio.hrv - bioStats.hrv.mean) / bioStats.hrv.sd : 0);
      if (includeRhr && bioStats.rhr.count > 0) row.push(bio.rhr != null ? (bio.rhr - bioStats.rhr.mean) / bioStats.rhr.sd : 0);
      if (includeDeep && bioStats.deep.count > 0) row.push(bio.deepSleepPct != null ? (bio.deepSleepPct - bioStats.deep.mean) / bioStats.deep.sd : 0);
    }
    X.push(row); Yarr.push(yVal); groups.push(new Date(r.date).getDay()); dates.push(r.date);
  }

  if (X.length < 5) return { error: `预测目标"${target.label}"有效记录不足 5 条` };
  if (X.some(row => row.length !== featureNames.length)) return { error: '模型特征维度不一致，请检查指标组合' };

  // Drop zero-variance columns
  const droppedFeatures = [];
  const keep = [];
  for (let j = 0; j < featureNames.length; j++) {
    let mean = 0; for (let i = 0; i < X.length; i++) mean += X[i][j]; mean /= X.length;
    let variance = 0; for (let i = 0; i < X.length; i++) variance += (X[i][j] - mean) ** 2; variance /= Math.max(X.length - 1, 1);
    if (variance < 1e-10) droppedFeatures.push(featureNames[j]); else keep.push(j);
  }
  if (keep.length !== featureNames.length) {
    for (let i = 0; i < X.length; i++) X[i] = keep.map(j => X[i][j]);
    const nn = keep.map(j => featureNames[j]); const nt = keep.map(j => featureTypes[j]);
    featureNames.length = 0; featureNames.push(...nn); featureTypes.length = 0; featureTypes.push(...nt);
  }
  if (!featureNames.length) return { error: '当前窗口内所有特征方差为零（恒定值）' };

  const regularization = { enabled: false, lambda: 1e-6 };
  const result = target.type === 'ordinal'
    ? fitOrdinalMixed(X, Yarr, groups, useWeekdayRandomIntercept, regularization)
    : fitLinearRegression(X, Yarr, regularization);

  if (!result) return { error: '模型拟合失败 — 数据不足或特征共线' };

  // ---- Compute per-day match scores ----
  const dailyMatch = [];
  const p = result.beta.length;
  if (target.type === 'ordinal') {
    const K = result.K;
    const levels = result.levels;
    const alpha = result.alpha;
    const beta = result.beta;
    for (let i = 0; i < X.length; i++) {
      let eta = 0;
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      // Compute P(Y = actual_k) using cumulative logit
      const actualIdx = levels.indexOf(Yarr[i]);
      // P(Y <= k) = sigmoid(alpha[k] - eta)
      const upper = actualIdx < K - 1 ? sigmoid(alpha[actualIdx] - eta) : 1;
      const lower = actualIdx > 0 ? sigmoid(alpha[actualIdx - 1] - eta) : 0;
      const pActual = Math.max(upper - lower, 0);
      // Compute expected (mean) category index
      let expectedIdx = 0;
      for (let k = 0; k < K; k++) {
        const pu = k < K - 1 ? sigmoid(alpha[k] - eta) : 1;
        const pl = k > 0 ? sigmoid(alpha[k - 1] - eta) : 0;
        expectedIdx += k * Math.max(pu - pl, 0);
      }
      dailyMatch.push({
        date: dates[i],
        actual: Yarr[i],
        predicted: levels[Math.round(Math.min(Math.max(expectedIdx, 0), K - 1))],
        matchPct: Math.round(pActual * 100),
      });
    }
  } else {
    // Continuous: predicted = intercept + X * beta
    const intercept = result.intercept || 0;
    const beta = result.beta;
    const yMin = Math.min(...Yarr);
    const yMax = Math.max(...Yarr);
    const yRange = Math.max(yMax - yMin, 1e-6);
    for (let i = 0; i < X.length; i++) {
      let pred = intercept;
      for (let j = 0; j < p; j++) pred += X[i][j] * beta[j];
      const error = Math.abs(Yarr[i] - pred);
      const matchPct = Math.round(Math.max(0, 1 - error / yRange) * 100);
      dailyMatch.push({
        date: dates[i],
        actual: +Yarr[i].toFixed(2),
        predicted: +pred.toFixed(2),
        matchPct,
      });
    }
  }

  return { ...result, featureNames, featureTypes, targetKey: predictionTarget, targetLabel: target.label, targetType: target.type, targetUnit: target.unit, droppedFeatures, regularization, dailyMatch };
}

module.exports = { runAnalysis, PRED_TARGETS };
