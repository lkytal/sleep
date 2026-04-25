/* analysis.js — Ordinal Mixed Effects Model with selectable feature groups */
/* Model: Cumulative logit (proportional odds) with day-of-week random intercepts
 *   P(Y ≤ j | x, b_g) = sigmoid(α_j − x′β − b_g)
 *   b_g ~ N(0, σ²_b)
 * Feature groups selectable via checkboxes:
 *   - medTaken: supplement taken (0/1)
 *   - medTime:  supplement time offset (hours from mean)
 *   - medDose:  supplement dose (standardized)
 *   - events:   sleep events (0/1 per event type)
 *   - sleepTime: bedtime, durations, prev-day features */
const Analysis = (() => {
  let chart = null;
  let allMeds = [], allEvents = [];
  // Feature group toggle state — medTaken is default checked
  const featureGroups = {
    medTaken:  { label: '💊 补剂种类', checked: true },
    medTime:   { label: '⏰ 补剂时间', checked: false },
    medDose:   { label: '💉 补剂剂量', checked: false },
    events:    { label: '📝 睡眠事件', checked: false },
    sleepTime: { label: '🕐 睡眠时间因素', checked: false },
  };

  async function init() {
    allMeds = await Data.loadMedications();
    allEvents = await Data.loadEvents();
    renderFeatureCheckboxes();
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

  function toggleGroup(key, cb) {
    featureGroups[key].checked = cb.checked;
    cb.parentElement.classList.toggle('checked', cb.checked);
    refresh();
  }

  // ========== Main refresh ==========
  function refresh() {
    const records = Data.getRecordsSorted();
    const activeGroups = Object.entries(featureGroups).filter(([, g]) => g.checked).map(([k]) => k);

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

    // --- Precompute means for standardization ---
    const medMeanMin = computeMedMeans(records, medIds);
    const medMeanDose = computeMedMeanDose(records, medIds);

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
      featureNames.push('当日有效睡眠'); featureTypes.push('sleep');
      featureNames.push('前日有效睡眠'); featureTypes.push('sleep');
      featureNames.push('前日睡眠评分'); featureTypes.push('sleep');
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
        row.push((r.effectiveSleep - meanSleep) / sdSleep);
        row.push((prevRecord.effectiveSleep - meanSleep) / sdSleep);
        row.push(prevRecord.score / 5 - 1);
      }

      X.push(row); Y.push(r.score);
      groups.push(new Date(r.date).getDay());
    }

    if (X.length < 5) {
      renderEmpty('有效记录不足 5 条（可能缺少连续日期数据）');
      renderStats(null); renderLegend([]);
      return;
    }

    const result = fitOrdinalMixed(X, Y, groups);
    if (!result) {
      renderEmpty('模型拟合失败 — 数据不足或特征共线');
      renderStats(null); renderLegend([]);
      return;
    }
    renderChart(featureNames, featureTypes, result.beta, result.oddsRatios);
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

  // ========== Rendering ==========
  const TYPE_COLORS = {
    taken:  { pos: ['rgba(85,239,196,0.75)', '#55efc4'],  neg: ['rgba(225,112,85,0.75)', '#e17055'] },
    offset: { pos: ['rgba(116,185,255,0.75)', '#74b9ff'], neg: ['rgba(253,203,110,0.75)', '#fdcb6e'] },
    dose:   { pos: ['rgba(0,206,201,0.75)', '#00cec9'],   neg: ['rgba(214,48,49,0.65)', '#d63031'] },
    event:  { pos: ['rgba(253,121,168,0.75)', '#fd79a8'], neg: ['rgba(99,110,114,0.65)', '#636e72'] },
    sleep:  { pos: ['rgba(162,155,254,0.75)', '#a29bfe'], neg: ['rgba(255,234,167,0.75)', '#ffeaa7'] },
  };

  function getColor(type, value) {
    const c = TYPE_COLORS[type] || TYPE_COLORS.sleep;
    return value >= 0 ? c.pos : c.neg;
  }

  function renderChart(featureNames, featureTypes, weights, oddsRatios) {
    const ctx = document.getElementById('analysis-chart').getContext('2d');
    if (chart) chart.destroy();
    const bgColors = weights.map((w, i) => getColor(featureTypes[i], w)[0]);
    const borderColors = weights.map((w, i) => getColor(featureTypes[i], w)[1]);

    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: featureNames,
        datasets: [{ label: '固定效应系数', data: weights, backgroundColor: bgColors, borderColor: borderColors, borderWidth: 2, borderRadius: 6, borderSkipped: false }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(17,24,39,0.95)', borderColor: '#6c5ce7', borderWidth: 1,
            titleFont: { family: 'Inter' }, bodyFont: { family: 'Inter' },
            callbacks: {
              label: tip => {
                const v = tip.parsed.x, or = oddsRatios[tip.dataIndex];
                return [`系数: ${v >= 0 ? '+' : ''}${v.toFixed(4)}`, `OR: ${or.toFixed(3)}`];
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: c => c.tick.value === 0 ? 'rgba(136,146,168,0.6)' : 'rgba(42,48,80,0.3)' },
            ticks: { color: '#8892a8', font: { family: 'Inter', size: 11 } },
            title: { display: true, text: '固定效应系数 (log-odds)', color: '#8892a8', font: { family: 'Inter', size: 12 } }
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
            const or = oddsRatios[index], sign = value >= 0 ? '+' : '';
            ctx.fillStyle = '#e8ecf4'; ctx.font = '600 11px Inter, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.textAlign = value >= 0 ? 'left' : 'right';
            ctx.fillText(`${sign}${value.toFixed(3)} (OR ${or.toFixed(2)})`, xPos + (value >= 0 ? 6 : -6), yPos);
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
    const r2Pct = (stats.pseudoR2 * 100).toFixed(1);
    const r2Color = stats.pseudoR2 > 0.3 ? 'var(--accent5)' : stats.pseudoR2 > 0.1 ? 'var(--accent4)' : 'var(--accent3)';
    const sigmaB = Math.sqrt(stats.sigma2).toFixed(3);
    const reHtml = stats.randomEffects
      .map(re => `<span class="re-chip" style="opacity:${0.5 + Math.min(Math.abs(re.value), 1) * 0.5}">周${re.day} <em>${re.value >= 0 ? '+' : ''}${re.value.toFixed(3)}</em></span>`)
      .join('');
    el.innerHTML = `
      <div class="stat-card"><span class="stat-label">McFadden R²</span><span class="stat-value" style="color:${r2Color}">${r2Pct}%</span><span class="stat-desc">${stats.pseudoR2 > 0.3 ? '拟合良好' : stats.pseudoR2 > 0.1 ? '拟合一般' : '拟合较弱'}</span></div>
      <div class="stat-card"><span class="stat-label">Log-Likelihood</span><span class="stat-value">${stats.logLik.toFixed(1)}</span><span class="stat-desc">AIC: ${stats.aic.toFixed(1)}</span></div>
      <div class="stat-card"><span class="stat-label">随机效应 σ</span><span class="stat-value">${sigmaB}</span><span class="stat-desc">星期分组截距SD</span></div>
      <div class="stat-card"><span class="stat-label">模型规模</span><span class="stat-value">${stats.n}</span><span class="stat-desc">${stats.K} 个有序等级, ${stats.p} 个特征</span></div>
      <div class="stat-card stat-card-wide"><span class="stat-label">随机截距 (星期)</span><div class="re-chips">${reHtml}</div></div>`;
  }

  function renderLegend(featureTypes) {
    const el = document.getElementById('analysis-legend');
    const active = [...new Set(featureTypes)];
    const labels = {
      taken: '补剂种类', offset: '补剂时间', dose: '补剂剂量', event: '睡眠事件', sleep: '睡眠时间',
    };
    el.innerHTML = active.map(t => {
      const c = TYPE_COLORS[t];
      return `<div class="legend-item"><span class="legend-dot" style="background:${c.pos[1]}"></span>${labels[t] || t} (正)</div>
              <div class="legend-item"><span class="legend-dot" style="background:${c.neg[1]}"></span>${labels[t] || t} (负)</div>`;
    }).join('');
  }

  return { init, refresh, toggleGroup };
})();
