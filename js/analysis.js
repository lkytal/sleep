/* analysis.js — Ordinal Mixed Effects Model with selectable feature groups */
/* Model: Cumulative logit (proportional odds) with day-of-week random intercepts
 *   P(Y ≤ j | x, b_g) = sigmoid(α_j − x′β − b_g)
 *   b_g ~ N(0, σ²_b)
 * Feature groups selectable via checkboxes:
 *   - medTaken: supplement taken (0/1)
 *   - medTime:  supplement time offset (hours from mean)
 *   - medDose:  supplement dose (standardized)
 *   - events:   sleep events (0/1 per event type)
 *   - sleepTime: bedtime, durations, prev-day features
 *   - bioMetrics: HRV, resting HR, deep sleep % (standardized) */
const Analysis = (() => {
  let chart = null;
  let allMeds = [], allEvents = [];
  let windowDays = 0; // 0 = all
  let predictionTarget = 'score';
  // Feature group toggle state — medTaken is default checked
  const featureGroups = {
    medTaken: { label: '💊 补剂种类', checked: true },
    medTime: { label: '⏰ 补剂时间', checked: true },
    medDose: { label: '💉 补剂剂量', checked: false },
    events: { label: '📝 睡眠事件', checked: false },
    sleepTime: { label: '🕐 睡眠时间因素', checked: false },
    bioMetrics: { label: '📊 生理指标', checked: false },
  };
  const predictionTargets = {
    score: { label: '睡眠分数', type: 'ordinal', unit: '分', getValue: r => r.score },
    hrv: { label: 'HRV', type: 'continuous', unit: 'ms', getValue: r => (r.biometrics || {}).hrv },
    deepSleepPct: { label: '深睡比例', type: 'continuous', unit: '%', getValue: r => (r.biometrics || {}).deepSleepPct },
    rhr: { label: '静息心率', type: 'continuous', unit: 'bpm', getValue: r => (r.biometrics || {}).rhr },
    effectiveSleep: { label: '睡眠时长', type: 'continuous', unit: '小时', getValue: r => r.effectiveSleep },
  };

  async function init() {
    allMeds = await Data.loadMedications();
    allEvents = await Data.loadEvents();
    renderFeatureCheckboxes();
    renderTargetSelect();
    refresh();
  }

  // ========== Feature checkbox UI ==========
  function renderFeatureCheckboxes() {
    const el = document.getElementById('analysis-features');
    el.innerHTML = Object.entries(featureGroups).map(([key, g]) =>
      `<label class="af-chip${g.checked ? ' checked' : ''}">
        <input type="checkbox" ${g.checked ? 'checked' : ''} onchange="Analysis.toggleGroup('${key}',this)">
        <span>${g.label}</span>
      </label>`
    ).join('');
  }

  function renderTargetSelect() {
    const el = document.getElementById('analysis-target');
    if (!el) return;
    el.innerHTML = Object.entries(predictionTargets).map(([key, target]) =>
      `<option value="${key}" ${key === predictionTarget ? 'selected' : ''}>${target.label}</option>`
    ).join('');
  }

  function toggleGroup(key, cb) {
    featureGroups[key].checked = cb.checked;
    cb.parentElement.classList.toggle('checked', cb.checked);
    refresh();
  }

  function setWindow(days, btn) {
    windowDays = days;
    document.querySelectorAll('#page-analysis .window-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    refresh();
  }

  function setTarget(targetKey) {
    if (!predictionTargets[targetKey]) return;
    predictionTarget = targetKey;
    refresh();
  }

  // ========== Main refresh ==========
  function refresh() {
    let records = Data.getRecordsSorted();
    if (windowDays > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - windowDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      records = records.filter(r => r.date >= cutoffStr);
    }
    const activeGroups = Object.entries(featureGroups).filter(([, g]) => g.checked).map(([k]) => k);
    const target = predictionTargets[predictionTarget];

    if (activeGroups.length === 0) {
      renderEmpty('请至少勾选一个指标组');
      renderStats(null); renderLegend([]);
      return;
    }
    if (records.length < 5) {
      renderEmpty('至少需要 5 条记录才能进行回归分析');
      renderStats(null); renderLegend([]);
      return;
    }

    const medIds = allMeds.map(m => m.id);
    const eventIds = allEvents.map(e => e.id);
    const has = k => activeGroups.includes(k);
    const needsPrev = has('sleepTime');
    const needsBio = has('bioMetrics');
    const includeCurrentSleep = predictionTarget !== 'effectiveSleep';
    const includeHrv = predictionTarget !== 'hrv';
    const includeRhr = predictionTarget !== 'rhr';
    const includeDeep = predictionTarget !== 'deepSleepPct';

    // --- Precompute means for standardization ---
    const medMeanMin = computeMedMeans(records, medIds);
    const medMeanDose = computeMedMeanDose(records, medIds);

    // Bio metrics stats (z-score)
    let bioStats = { hrv: {}, rhr: {}, deep: {} };
    if (needsBio) {
      bioStats = computeBioStats(records);
    }

    let meanSleep = 0, sdSleep = 1, meanBed = 0, sdBed = 1;
    if (needsPrev) {
      // effective sleep stats
      let s1 = 0, s2 = 0;
      records.forEach(r => { s1 += r.effectiveSleep; });
      meanSleep = s1 / records.length;
      records.forEach(r => { s2 += (r.effectiveSleep - meanSleep) ** 2; });
      sdSleep = Math.sqrt(s2 / records.length) || 1;
      // bedtime stats
      let b1 = 0, b2 = 0;
      records.forEach(r => {
        let bm = r.bedtime.hour * 60 + r.bedtime.minute;
        if (bm < 720) bm += 1440;
        b1 += bm;
      });
      meanBed = b1 / records.length;
      records.forEach(r => {
        let bm = r.bedtime.hour * 60 + r.bedtime.minute;
        if (bm < 720) bm += 1440;
        b2 += (bm - meanBed) ** 2;
      });
      sdBed = Math.sqrt(b2 / records.length) || 1;
    }

    // --- Build feature names & types ---
    const featureNames = [], featureTypes = [];
    if (has('medTaken')) {
      medIds.forEach(id => {
        const name = (allMeds.find(m => m.id === id) || {}).name || id;
        featureNames.push(`${name} 服用`); featureTypes.push('taken');
      });
    }
    if (has('medTime')) {
      medIds.forEach(id => {
        const name = (allMeds.find(m => m.id === id) || {}).name || id;
        featureNames.push(`${name} 时间偏移`); featureTypes.push('offset');
      });
    }
    if (has('medDose')) {
      medIds.forEach(id => {
        const name = (allMeds.find(m => m.id === id) || {}).name || id;
        featureNames.push(`${name} 剂量`); featureTypes.push('dose');
      });
    }
    if (has('events')) {
      eventIds.forEach(id => {
        const name = (allEvents.find(e => e.id === id) || {}).name || id;
        featureNames.push(name); featureTypes.push('event');
      });
    }
    if (has('sleepTime')) {
      featureNames.push('绝对入睡时间'); featureTypes.push('sleep');
      if (includeCurrentSleep) { featureNames.push('当日有效睡眠'); featureTypes.push('sleep'); }
      featureNames.push('前日有效睡眠'); featureTypes.push('sleep');
      featureNames.push('前日睡眠评分'); featureTypes.push('sleep');
    }
    if (has('bioMetrics')) {
      if (includeHrv && bioStats.hrv.count > 0) { featureNames.push('HRV'); featureTypes.push('bio'); }
      if (includeRhr && bioStats.rhr.count > 0) { featureNames.push('静息心率'); featureTypes.push('bio'); }
      if (includeDeep && bioStats.deep.count > 0) { featureNames.push('深睡比例'); featureTypes.push('bio'); }
    }

    if (featureNames.length === 0) {
      renderEmpty('当前预测目标已从回归内容中移除，请再勾选其他指标组');
      renderStats(null); renderLegend([]);
      return;
    }

    // --- Build X, Y, groups ---
    const dateMap = {};
    records.forEach(r => { dateMap[r.date] = r; });
    const X = [], Y = [], groups = [];

    for (const r of records) {
      // If sleepTime is active, require previous day
      let prevRecord = null;
      if (needsPrev) {
        const prevDate = new Date(r.date);
        prevDate.setDate(prevDate.getDate() - 1);
        prevRecord = dateMap[prevDate.toISOString().slice(0, 10)];
        if (!prevRecord) continue;
      }

      const yValue = Number(target.getValue(r));
      if (!Number.isFinite(yValue)) continue;

      const row = [];
      const medMap = {};
      (r.medications || []).forEach(m => { medMap[m.id] = m; });

      if (has('medTaken')) {
        medIds.forEach(id => row.push(medMap[id] ? 1 : 0));
      }
      if (has('medTime')) {
        medIds.forEach(id => {
          const med = medMap[id];
          if (med && medMeanMin[id] !== null) {
            let diff = (med.time.hour * 60 + med.time.minute) - medMeanMin[id];
            if (diff > 720) diff -= 1440;
            if (diff < -720) diff += 1440;
            row.push(diff / 60);
          } else {
            row.push(0);
          }
        });
      }
      if (has('medDose')) {
        medIds.forEach(id => {
          const med = medMap[id];
          if (med && med.dose && medMeanDose[id]) {
            const dv = parseDoseValue(med.dose);
            row.push(dv !== null ? (dv - medMeanDose[id].mean) / (medMeanDose[id].sd || 1) : 0);
          } else {
            row.push(0);
          }
        });
      }
      if (has('events')) {
        const evSet = new Set(r.events || []);
        eventIds.forEach(id => row.push(evSet.has(id) ? 1 : 0));
      }
      if (has('sleepTime')) {
        let bedMin = r.bedtime.hour * 60 + r.bedtime.minute;
        if (bedMin < 720) bedMin += 1440;
        row.push((bedMin - meanBed) / sdBed);
        if (includeCurrentSleep) row.push((r.effectiveSleep - meanSleep) / sdSleep);
        row.push((prevRecord.effectiveSleep - meanSleep) / sdSleep);
        row.push(prevRecord.score / 5 - 1);
      }
      if (has('bioMetrics')) {
        const bio = r.biometrics || {};
        if (includeHrv && bioStats.hrv.count > 0) row.push(bio.hrv != null ? (bio.hrv - bioStats.hrv.mean) / bioStats.hrv.sd : 0);
        if (includeRhr && bioStats.rhr.count > 0) row.push(bio.rhr != null ? (bio.rhr - bioStats.rhr.mean) / bioStats.rhr.sd : 0);
        if (includeDeep && bioStats.deep.count > 0) row.push(bio.deepSleepPct != null ? (bio.deepSleepPct - bioStats.deep.mean) / bioStats.deep.sd : 0);
      }

      X.push(row); Y.push(yValue);
      groups.push(new Date(r.date).getDay());
    }

    if (X.length < 5) {
      renderEmpty(`预测目标“${target.label}”有效记录不足 5 条`);
      renderStats(null); renderLegend([]);
      return;
    }

    const result = target.type === 'ordinal'
      ? fitOrdinalMixed(X, Y, groups)
      : fitLinearRegression(X, Y);
    if (!result) {
      renderEmpty('模型拟合失败 — 数据不足或特征共线');
      renderStats(null); renderLegend([]);
      return;
    }
    result.target = target;
    result.modelType = target.type;
    renderChart(featureNames, featureTypes, result.beta, result.oddsRatios, result.randomEffects, result);
    renderStats(result);
    renderLegend(featureTypes);
  }

  // ========== Data helpers ==========
  function computeMedMeans(records, medIds) {
    const sums = {};
    medIds.forEach(id => { sums[id] = { totalMin: 0, count: 0 }; });
    records.forEach(r => {
      (r.medications || []).forEach(m => {
        if (!sums[m.id]) return;
        sums[m.id].totalMin += m.time.hour * 60 + m.time.minute;
        sums[m.id].count += 1;
      });
    });
    const means = {};
    medIds.forEach(id => {
      means[id] = sums[id].count > 0 ? sums[id].totalMin / sums[id].count : null;
    });
    return means;
  }

  function parseDoseValue(doseStr) {
    if (!doseStr) return null;
    const m = String(doseStr).match(/^([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }

  function computeMedMeanDose(records, medIds) {
    const acc = {};
    medIds.forEach(id => { acc[id] = { vals: [] }; });
    records.forEach(r => {
      (r.medications || []).forEach(m => {
        if (!acc[m.id]) return;
        const dv = parseDoseValue(m.dose);
        if (dv !== null) acc[m.id].vals.push(dv);
      });
    });
    const result = {};
    medIds.forEach(id => {
      const v = acc[id].vals;
      if (v.length === 0) { result[id] = null; return; }
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) || 1;
      result[id] = { mean, sd };
    });
    return result;
  }

  function computeBioStats(records) {
    const hrvVals = [], rhrVals = [], deepVals = [];
    records.forEach(r => {
      const bio = r.biometrics || {};
      if (bio.hrv != null) hrvVals.push(bio.hrv);
      if (bio.rhr != null) rhrVals.push(bio.rhr);
      if (bio.deepSleepPct != null) deepVals.push(bio.deepSleepPct);
    });
    const stat = vals => {
      if (vals.length === 0) return { mean: 0, sd: 1, count: 0 };
      const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length) || 1;
      return { mean, sd, count: vals.length };
    };
    return { hrv: stat(hrvVals), rhr: stat(rhrVals), deep: stat(deepVals) };
  }

  // ========== Math helpers ==========
  function sigmoid(z) {
    if (z > 20) return 1 - 1e-9;
    if (z < -20) return 1e-9;
    return 1 / (1 + Math.exp(-z));
  }

  function ordProb(k, K, alpha, eta) {
    const upper = k < K - 1 ? sigmoid(alpha[k] - eta) : 1;
    const lower = k > 0 ? sigmoid(alpha[k - 1] - eta) : 0;
    return Math.max(upper - lower, 1e-12);
  }

  function penalizedLogLik(X, yIdx, K, alpha, beta, b, gIdx, sigma2) {
    const n = X.length, p = X[0].length;
    let ll = 0;
    for (let i = 0; i < n; i++) {
      let eta = b[gIdx[i]];
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      ll += Math.log(ordProb(yIdx[i], K, alpha, eta));
    }
    for (let g = 0; g < b.length; g++) ll -= 0.5 * b[g] * b[g] / Math.max(sigma2, 1e-6);
    return ll;
  }

  function computeGradients(X, yIdx, K, alpha, beta, b, gIdx, sigma2) {
    const n = X.length, p = X[0].length, nG = b.length;
    const gAlpha = new Float64Array(K - 1);
    const gBeta = new Float64Array(p);
    const gB = new Float64Array(nG);
    for (let i = 0; i < n; i++) {
      let eta = b[gIdx[i]];
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      const k = yIdx[i];
      const prob = ordProb(k, K, alpha, eta);
      let fUpper = 0, fLower = 0;
      if (k < K - 1) { const s = sigmoid(alpha[k] - eta); fUpper = s * (1 - s); }
      if (k > 0) { const s = sigmoid(alpha[k - 1] - eta); fLower = s * (1 - s); }
      const dEta = (-fUpper + fLower) / prob;
      for (let j = 0; j < p; j++) gBeta[j] += dEta * X[i][j];
      gB[gIdx[i]] += dEta;
      if (k < K - 1) gAlpha[k] += fUpper / prob;
      if (k > 0) gAlpha[k - 1] -= fLower / prob;
    }
    for (let g = 0; g < nG; g++) gB[g] -= b[g] / Math.max(sigma2, 1e-6);
    return { gAlpha, gBeta, gB };
  }

  // ========== Model fitting ==========
  function fitOrdinalMixed(X, Y, groups) {
    const levels = [...new Set(Y)].sort((a, b) => a - b);
    const K = levels.length;
    if (K < 2) return null;
    const yIdx = Y.map(y => levels.indexOf(y));
    const n = X.length, p = X[0].length;
    const uGroups = [...new Set(groups)];
    const nG = uGroups.length;
    const gMap = {}; uGroups.forEach((g, i) => { gMap[g] = i; });
    const gIdx = groups.map(g => gMap[g]);

    let alpha = [];
    for (let j = 0; j < K - 1; j++) {
      const cp = yIdx.filter(y => y <= j).length / n;
      alpha.push(Math.log(Math.max(0.02, Math.min(0.98, cp)) / (1 - Math.max(0.02, Math.min(0.98, cp)))));
    }
    let beta = new Array(p).fill(0);
    let b = new Array(nG).fill(0);
    let sigma2 = 0.5, lr = 0.05, prevLL = -Infinity;

    for (let iter = 0; iter < 500; iter++) {
      const { gAlpha, gBeta, gB } = computeGradients(X, yIdx, K, alpha, beta, b, gIdx, sigma2);
      const newAlpha = alpha.map((a, j) => a + lr * gAlpha[j]);
      const newBeta = beta.map((bv, j) => bv + lr * gBeta[j]);
      const newB = b.map((bv, g) => bv + lr * gB[g]);
      for (let j = 1; j < K - 1; j++) {
        if (newAlpha[j] <= newAlpha[j - 1] + 0.01) newAlpha[j] = newAlpha[j - 1] + 0.01;
      }
      const newLL = penalizedLogLik(X, yIdx, K, newAlpha, newBeta, newB, gIdx, sigma2);
      if (newLL > prevLL) {
        alpha = newAlpha; beta = newBeta; b = newB;
        prevLL = newLL; lr = Math.min(lr * 1.05, 0.2);
      } else {
        lr *= 0.5; if (lr < 1e-8) break; continue;
      }
      if (iter % 10 === 0 && iter > 0) {
        let ss = 0; for (let g = 0; g < nG; g++) ss += b[g] * b[g];
        sigma2 = Math.max(ss / nG, 0.01);
      }
      if (iter > 20 && gBeta.reduce((s, v) => s + v * v, 0) < 1e-10) break;
    }

    let logLik = 0;
    for (let i = 0; i < n; i++) {
      let eta = b[gIdx[i]];
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      logLik += Math.log(ordProb(yIdx[i], K, alpha, eta));
    }
    const numParams = (K - 1) + p + 1;
    const aic = -2 * logLik + 2 * numParams;
    const oddsRatios = beta.map(b => Math.exp(b));
    let llNull = 0;
    for (let i = 0; i < n; i++) llNull += Math.log(ordProb(yIdx[i], K, alpha, 0));
    const pseudoR2 = 1 - logLik / llNull;
    const dayLabels = ['日', '一', '二', '三', '四', '五', '六'];
    const randomEffects = uGroups.map((g, i) => ({ day: dayLabels[g], value: b[i] }));

    return { beta: Array.from(beta), oddsRatios, alpha, sigma2, logLik, aic, pseudoR2, n, p, K, levels, randomEffects, numParams };
  }

  function solveLinearSystem(A, b) {
    const n = A.length;
    const M = A.map((row, i) => row.concat(b[i]));
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-12) return null;
      if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];
      const div = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= div;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col];
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map(row => row[n]);
  }

  function fitLinearRegression(X, Y) {
    const n = X.length, p = X[0].length, q = p + 1;
    if (n < 5 || p < 1) return null;
    const xtx = Array.from({ length: q }, () => new Array(q).fill(0));
    const xty = new Array(q).fill(0);

    for (let i = 0; i < n; i++) {
      const row = [1].concat(X[i]);
      for (let a = 0; a < q; a++) {
        xty[a] += row[a] * Y[i];
        for (let b = 0; b < q; b++) xtx[a][b] += row[a] * row[b];
      }
    }
    for (let j = 1; j < q; j++) xtx[j][j] += 1e-6;

    const coef = solveLinearSystem(xtx, xty);
    if (!coef) return null;

    const meanY = Y.reduce((s, y) => s + y, 0) / n;
    let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      let pred = coef[0];
      for (let j = 0; j < p; j++) pred += X[i][j] * coef[j + 1];
      sse += (Y[i] - pred) ** 2;
      sst += (Y[i] - meanY) ** 2;
    }

    const sigma2 = Math.max(sse / n, 1e-9);
    const logLik = -0.5 * n * (Math.log(2 * Math.PI * sigma2) + 1);
    const numParams = q + 1;
    const r2 = sst > 0 ? 1 - sse / sst : 0;
    return {
      beta: coef.slice(1),
      intercept: coef[0],
      r2,
      rmse: Math.sqrt(sigma2),
      logLik,
      aic: -2 * logLik + 2 * numParams,
      n,
      p,
      numParams,
    };
  }

  // ========== Rendering ==========
  const TYPE_COLORS = {
    taken: { pos: ['rgba(85,239,196,0.75)', '#55efc4'], neg: ['rgba(225,112,85,0.75)', '#e17055'] },
    offset: { pos: ['rgba(116,185,255,0.75)', '#74b9ff'], neg: ['rgba(253,203,110,0.75)', '#fdcb6e'] },
    dose: { pos: ['rgba(0,206,201,0.75)', '#00cec9'], neg: ['rgba(214,48,49,0.65)', '#d63031'] },
    event: { pos: ['rgba(253,121,168,0.75)', '#fd79a8'], neg: ['rgba(99,110,114,0.65)', '#636e72'] },
    sleep: { pos: ['rgba(162,155,254,0.75)', '#a29bfe'], neg: ['rgba(255,234,167,0.75)', '#ffeaa7'] },
    bio:   { pos: ['rgba(129,236,236,0.75)', '#81ecec'], neg: ['rgba(255,118,117,0.75)', '#ff7675'] },
  };

  function getColor(type, value) {
    const c = TYPE_COLORS[type] || TYPE_COLORS.sleep;
    return value >= 0 ? c.pos : c.neg;
  }

  function renderChart(featureNames, featureTypes, weights, oddsRatios, randomEffects, modelInfo) {
    const ctx = document.getElementById('analysis-chart').getContext('2d');
    if (chart) chart.destroy();
    const isOrdinal = modelInfo.modelType === 'ordinal';
    const unit = modelInfo.target.unit ? ` ${modelInfo.target.unit}` : '';
    const bgColors = weights.map((w, i) => getColor(featureTypes[i], w)[0]);
    const borderColors = weights.map((w, i) => getColor(featureTypes[i], w)[1]);

    const titleText = isOrdinal
      ? `随机截距 ▸ ${randomEffects.map(re => `周${re.day} ${re.value >= 0 ? '+' : ''}${re.value.toFixed(2)}`).join('  ')}`
      : `线性回归 ▸ 目标：${modelInfo.target.label} · R² ${(modelInfo.r2 * 100).toFixed(1)}% · RMSE ${modelInfo.rmse.toFixed(2)}${unit}`;

    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: featureNames,
        datasets: [{ label: isOrdinal ? '固定效应系数' : '线性回归系数', data: weights, backgroundColor: bgColors, borderColor: borderColors, borderWidth: 2, borderRadius: 6, borderSkipped: false }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        layout: { padding: { top: 4 } },
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: titleText,
            color: '#5a6480',
            font: { family: 'Inter, Noto Sans SC', size: 11, weight: 500 },
            align: 'start',
            padding: { bottom: 8 }
          },
          tooltip: {
            backgroundColor: 'rgba(17,24,39,0.95)', borderColor: '#6c5ce7', borderWidth: 1,
            titleFont: { family: 'Inter' }, bodyFont: { family: 'Inter' },
            callbacks: {
              label: tip => {
                const v = tip.parsed.x;
                const label = `系数: ${v >= 0 ? '+' : ''}${v.toFixed(4)}`;
                if (!isOrdinal) return [label, `目标: ${modelInfo.target.label}`];
                const or = oddsRatios[tip.dataIndex];
                return [label, `OR: ${or.toFixed(3)}`];
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: c => c.tick.value === 0 ? 'rgba(136,146,168,0.6)' : 'rgba(42,48,80,0.3)' },
            ticks: { color: '#8892a8', font: { family: 'Inter', size: 11 } },
            title: { display: true, text: isOrdinal ? '固定效应系数 (log-odds)' : `线性回归系数（目标：${modelInfo.target.label}）`, color: '#8892a8', font: { family: 'Inter', size: 12 } }
          },
          y: { grid: { display: false }, ticks: { color: '#e8ecf4', font: { family: 'Inter, Noto Sans SC', size: 12, weight: 500 } } }
        }
      },
      plugins: [{
        id: 'weightLabels',
        afterDatasetsDraw(ch) {
          const { ctx, data, scales: { x, y } } = ch;
          ctx.save();
          data.datasets[0].data.forEach((value, index) => {
            const xPos = x.getPixelForValue(value), yPos = y.getPixelForValue(index);
            const sign = value >= 0 ? '+' : '';
            const suffix = isOrdinal ? ` (OR ${oddsRatios[index].toFixed(2)})` : '';
            ctx.fillStyle = '#e8ecf4'; ctx.font = '600 11px Inter, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.textAlign = value >= 0 ? 'left' : 'right';
            ctx.fillText(`${sign}${value.toFixed(3)}${suffix}`, xPos + (value >= 0 ? 6 : -6), yPos);
          });
          ctx.restore();
        }
      }]
    });
  }

  function renderEmpty(msg) {
    const ctx = document.getElementById('analysis-chart').getContext('2d');
    if (chart) { chart.destroy(); chart = null; }
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#5a6480'; ctx.font = '16px Inter, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(msg, ctx.canvas.width / 2, ctx.canvas.height / 2);
  }

  function renderStats(stats) {
    const el = document.getElementById('analysis-stats');
    if (!stats) { el.innerHTML = ''; return; }
    if (stats.modelType === 'continuous') {
      const r2Pct = (stats.r2 * 100).toFixed(1);
      const r2Color = stats.r2 > 0.3 ? 'var(--accent5)' : stats.r2 > 0.1 ? 'var(--accent4)' : 'var(--accent3)';
      const unit = stats.target.unit ? ` ${stats.target.unit}` : '';
      el.innerHTML = `
        <div class="stat-card"><span class="stat-label">R²</span><span class="stat-value" style="color:${r2Color}">${r2Pct}%</span></div>
        <div class="stat-card"><span class="stat-label">RMSE</span><span class="stat-value">${stats.rmse.toFixed(2)}</span><span class="stat-desc">${stats.target.label}${unit}</span></div>
        <div class="stat-card"><span class="stat-label">LL / AIC</span><span class="stat-value">${stats.logLik.toFixed(0)}</span><span class="stat-desc">AIC ${stats.aic.toFixed(0)}</span></div>
        <div class="stat-card"><span class="stat-label">N</span><span class="stat-value">${stats.n}</span><span class="stat-desc">${stats.p}特征 线性</span></div>`;
      return;
    }
    const r2Pct = (stats.pseudoR2 * 100).toFixed(1);
    const r2Color = stats.pseudoR2 > 0.3 ? 'var(--accent5)' : stats.pseudoR2 > 0.1 ? 'var(--accent4)' : 'var(--accent3)';
    const sigmaB = Math.sqrt(stats.sigma2).toFixed(3);
    el.innerHTML = `
      <div class="stat-card"><span class="stat-label">R²</span><span class="stat-value" style="color:${r2Color}">${r2Pct}%</span></div>
      <div class="stat-card"><span class="stat-label">LL / AIC</span><span class="stat-value">${stats.logLik.toFixed(0)}</span><span class="stat-desc">AIC ${stats.aic.toFixed(0)}</span></div>
      <div class="stat-card"><span class="stat-label">σ随机</span><span class="stat-value">${sigmaB}</span></div>
      <div class="stat-card"><span class="stat-label">N</span><span class="stat-value">${stats.n}</span><span class="stat-desc">${stats.p}特征 ${stats.K}级</span></div>`;
  }

  function renderLegend(featureTypes) {
    const el = document.getElementById('analysis-legend');
    const active = [...new Set(featureTypes)];
    const labels = {
      taken: '补剂种类', offset: '补剂时间', dose: '补剂剂量', event: '睡眠事件', sleep: '睡眠时间', bio: '生理指标',
    };
    el.innerHTML = active.map(t => {
      const c = TYPE_COLORS[t];
      return `<div class="legend-item"><span class="legend-dot" style="background:${c.pos[1]}"></span>${labels[t] || t} (正)</div>
              <div class="legend-item"><span class="legend-dot" style="background:${c.neg[1]}"></span>${labels[t] || t} (负)</div>`;
    }).join('');
  }

  return { init, refresh, toggleGroup, setWindow, setTarget };
})();
