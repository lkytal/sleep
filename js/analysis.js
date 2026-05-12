/* analysis.js — Ordinal regression model with selectable feature groups */
/* Model: Cumulative logit (proportional odds), optionally with day-of-week random intercepts
 *   P(Y ≤ j | x, b_g) = sigmoid(α_j − x′β − b_g)
 *   α reparameterized as α_0, α_j = α_{j-1} + exp(δ_{j-1}) to enforce monotonicity.
 *   b_g ~ N(0, σ²_b), when weekday random intercepts are enabled.
 * Feature groups selectable via checkboxes:
 *   - medTaken:  supplement taken (0/1)              [main effect]
 *   - medTime:   (offsetHours − meanₜ)/sdₜ if taken, else 0   [taken × time interaction]
 *   - medDose:   (dose − meanₐ)/sdₐ if taken, else 0          [taken × dose interaction]
 *   - events:    sleep events (0/1 per event type)
 *   - sleepTime: bedtime, current/prev-day durations, prev-day score
 *   - bioMetrics: HRV, resting HR, deep sleep % (z-scored using the available subset)
 * The med standardization means/SDs are computed on the "taken" subsample only,
 * so medTime/medDose carry no information when the supplement was not taken;
 * they are pure interaction terms with medTaken. */
const Analysis = (() => {
  let chart = null;
  let allMeds = [], allEvents = [];
  let windowDays = 0; // 0 = all
  let startDate = null;
  let predictionTarget = 'score';
  let includeOutliers = false;
  // Feature group toggle state — medTaken is default checked
  const featureGroups = {
    medTaken: { label: '💊 补剂种类', checked: true },
    medTime: { label: '⏰ 补剂时间', checked: true },
    medDose: { label: '💉 补剂剂量', checked: true },
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
    const featureChips = Object.entries(featureGroups).map(([key, g]) =>
      `<label class="af-chip${g.checked ? ' checked' : ''}">
        <input type="checkbox" ${g.checked ? 'checked' : ''} onchange="Analysis.toggleGroup('${key}',this)">
        <span>${g.label}</span>
      </label>`
    ).join('');
    const outlierChip = `<label class="af-chip af-chip-outlier${includeOutliers ? ' checked' : ''}">
        <input type="checkbox" ${includeOutliers ? 'checked' : ''} onchange="Analysis.toggleOutlierInclusion(this)">
        <span>⚠️ 包含异常点</span>
      </label>`;
    el.innerHTML = featureChips + outlierChip;
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

  function toggleOutlierInclusion(cb) {
    includeOutliers = cb.checked;
    cb.parentElement.classList.toggle('checked', cb.checked);
    refresh();
  }

  function setWindow(days, btn) {
    windowDays = days;
    startDate = null;
    const dateInput = document.getElementById('analysis-start-date');
    if (dateInput) dateInput.value = '';
    document.querySelectorAll('#page-analysis .window-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    refresh();
  }

  function setStartDate(dateStr) {
    startDate = dateStr || null;
    if (startDate) {
      windowDays = 0;
      document.querySelectorAll('#page-analysis .window-btn').forEach(b => b.classList.remove('active'));
    } else {
      // If user clears the date input, default to 'all'
      setWindow(0, document.querySelector('#page-analysis .window-btn[data-days="0"]'));
      return;
    }
    refresh();
  }

  function setTarget(targetKey) {
    if (!predictionTargets[targetKey]) return;
    predictionTarget = targetKey;
    refresh();
  }

  // ========== Main refresh — delegates computation to backend ==========
  async function refresh() {
    const activeGroups = Object.entries(featureGroups).filter(([, g]) => g.checked).map(([k]) => k);

    if (activeGroups.length === 0) {
      renderEmpty('请至少勾选一个指标组');
      renderStats(null); renderLegend([]);
      return;
    }

    renderEmpty('计算中…');
    try {
      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: Data.getUserId(),
          windowDays,
          startDate,
          activeGroups,
          predictionTarget,
          useWeekdayRandomIntercept: false,
          includeOutliers,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        renderEmpty(data.error || '分析请求失败');
        renderStats(null); renderLegend([]);
        return;
      }
      // Reconstruct target object for rendering (labels/units)
      data.target = predictionTargets[data.targetKey] || predictionTargets[predictionTarget];
      data.modelType = data.targetType;
      renderChart(data.featureNames, data.featureTypes, data.beta, data.oddsRatios, data.randomEffects, data);
      renderStats(data);
      renderLegend(data.featureTypes);
    } catch (e) {
      renderEmpty(`⚠ 无法连接后端，请确认服务已启动 (port ${location.port})`);
      renderStats(null); renderLegend([]);
    }
  }

  // ========== Data helpers ==========
  function timeToMinutes(time) {
    if (!time) return NaN;
    return time.hour * 60 + time.minute;
  }

  function circularMinuteDiff(valueMin, centerMin) {
    let diff = valueMin - centerMin;
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    return diff;
  }

  function circularMeanMinutes(values) {
    if (values.length === 0) return 0;
    let sinSum = 0, cosSum = 0;
    values.forEach(min => {
      const radians = (min / 1440) * 2 * Math.PI;
      sinSum += Math.sin(radians);
      cosSum += Math.cos(radians);
    });
    const angle = Math.atan2(sinSum / values.length, cosSum / values.length);
    return ((angle < 0 ? angle + 2 * Math.PI : angle) / (2 * Math.PI)) * 1440;
  }

  function medicationBedtimeOffsetHours(med, record) {
    const medMin = timeToMinutes(med.time);
    const bedMin = timeToMinutes(record.bedtime);
    if (!Number.isFinite(medMin) || !Number.isFinite(bedMin)) return NaN;
    return circularMinuteDiff(medMin, bedMin) / 60;
  }

  function computeMedTimeStats(records, medIds) {
    const acc = {};
    medIds.forEach(id => { acc[id] = { vals: [] }; });
    records.forEach(r => {
      (r.medications || []).forEach(m => {
        if (!acc[m.id]) return;
        const offsetHours = medicationBedtimeOffsetHours(m, r);
        if (Number.isFinite(offsetHours)) acc[m.id].vals.push(offsetHours);
      });
    });
    const result = {};
    medIds.forEach(id => {
      const v = acc[id].vals;
      if (v.length === 0) { result[id] = null; return; }
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(v.length - 1, 1)) || 1;
      result[id] = { mean, sd };
    });
    return result;
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
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(v.length - 1, 1)) || 1;
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
      const sd = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(vals.length - 1, 1)) || 1;
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

  // Numerically stable log σ(x) — avoids overflow on either tail.
  function logSigmoid(x) {
    if (x >= 0) return -Math.log1p(Math.exp(-x));
    return x - Math.log1p(Math.exp(x));
  }

  // log P(Y = k | η) for the cumulative-logit ordinal model, computed in
  // log-space so that we never subtract two near-equal sigmoids (which used to
  // underflow to the 1e-12 floor in ordProb).
  function logOrdProb(k, K, alpha, eta) {
    if (k === 0) return logSigmoid(alpha[0] - eta);
    if (k === K - 1) return logSigmoid(eta - alpha[K - 2]);
    const a = alpha[k] - eta;          // strictly greater than b
    const b = alpha[k - 1] - eta;
    const logA = logSigmoid(a);
    const logB = logSigmoid(b);
    // log(σ(a) − σ(b)) = logA + log(1 − exp(logB − logA)); the inner exp is in [0,1).
    const ratio = Math.exp(logB - logA);
    if (ratio >= 1) return -700; // Numerical guard: treat as effectively zero probability.
    return logA + Math.log1p(-ratio);
  }

  function ordProb(k, K, alpha, eta) {
    // Kept for the gradient code path which already needs sigmoids in linear space.
    const upper = k < K - 1 ? sigmoid(alpha[k] - eta) : 1;
    const lower = k > 0 ? sigmoid(alpha[k - 1] - eta) : 0;
    return Math.max(upper - lower, 1e-12);
  }

  // Gauss–Jordan inversion of a square matrix; returns null on singularity.
  function invertMatrix(A) {
    const n = A.length;
    const M = A.map((row, i) => {
      const aug = row.slice();
      for (let j = 0; j < n; j++) aug.push(i === j ? 1 : 0);
      return aug;
    });
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-12) return null;
      if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];
      const div = M[col][col];
      for (let c = 0; c < 2 * n; c++) M[col][c] /= div;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col];
        if (factor === 0) continue;
        for (let c = 0; c < 2 * n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map(row => row.slice(n));
  }

  function penalizedLogLik(X, yIdx, K, alpha, beta, b, gIdx, sigma2, useRandomIntercept, ridgeLambda) {
    const n = X.length, p = X[0].length;
    let ll = 0;
    for (let i = 0; i < n; i++) {
      let eta = useRandomIntercept ? b[gIdx[i]] : 0;
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      ll += logOrdProb(yIdx[i], K, alpha, eta);
    }
    if (useRandomIntercept) {
      for (let g = 0; g < b.length; g++) ll -= 0.5 * b[g] * b[g] / Math.max(sigma2, 1e-6);
    }
    if (ridgeLambda > 0) {
      for (let j = 0; j < p; j++) ll -= 0.5 * ridgeLambda * beta[j] * beta[j];
    }
    return ll;
  }

  // Observed-information Hessian of the negative log-likelihood w.r.t. β,
  // conditional on (α, b) at the MLE. Used to derive Wald standard errors and
  // confidence intervals; conditioning on (α, b) keeps the matrix small (p×p)
  // and the SE slightly conservative compared to the joint inverse.
  function computeBetaHessian(X, yIdx, K, alpha, beta, b, gIdx, useRandomIntercept, ridgeLambda) {
    const n = X.length, p = X[0].length;
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i++) {
      let eta = useRandomIntercept ? b[gIdx[i]] : 0;
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      const k = yIdx[i];
      let sU = 0, sL = 0, fU = 0, fL = 0, pU = 1, pL = 0;
      if (k < K - 1) { sU = sigmoid(alpha[k] - eta); fU = sU * (1 - sU); pU = sU; }
      if (k > 0) { sL = sigmoid(alpha[k - 1] - eta); fL = sL * (1 - sL); pL = sL; }
      const P = Math.max(pU - pL, 1e-12);
      const dP = -fU + fL;
      const d2P = (k < K - 1 ? fU * (1 - 2 * sU) : 0) - (k > 0 ? fL * (1 - 2 * sL) : 0);
      // ∂² log P / ∂η² = d2P/P − (dP/P)²; observed Fisher info contributes −hEta.
      const hEta = d2P / P - (dP / P) * (dP / P);
      const w = -hEta;
      for (let jj = 0; jj < p; jj++) {
        const xij = X[i][jj];
        if (xij === 0) continue;
        const wxij = w * xij;
        for (let kk = jj; kk < p; kk++) H[jj][kk] += wxij * X[i][kk];
      }
    }
    for (let jj = 0; jj < p; jj++) {
      for (let kk = jj + 1; kk < p; kk++) H[kk][jj] = H[jj][kk];
    }
    if (ridgeLambda > 0) {
      for (let j = 0; j < p; j++) H[j][j] += ridgeLambda;
    }
    return H;
  }

  function computeGradients(X, yIdx, K, alpha, beta, b, gIdx, sigma2, useRandomIntercept, ridgeLambda) {
    const n = X.length, p = X[0].length, nG = b.length;
    const gAlpha = new Float64Array(K - 1);
    const gBeta = new Float64Array(p);
    const gB = new Float64Array(useRandomIntercept ? nG : 0);
    for (let i = 0; i < n; i++) {
      let eta = useRandomIntercept ? b[gIdx[i]] : 0;
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      const k = yIdx[i];
      const prob = ordProb(k, K, alpha, eta);
      let fUpper = 0, fLower = 0;
      if (k < K - 1) { const s = sigmoid(alpha[k] - eta); fUpper = s * (1 - s); }
      if (k > 0) { const s = sigmoid(alpha[k - 1] - eta); fLower = s * (1 - s); }
      const dEta = (-fUpper + fLower) / prob;
      for (let j = 0; j < p; j++) gBeta[j] += dEta * X[i][j];
      if (useRandomIntercept) gB[gIdx[i]] += dEta;
      if (k < K - 1) gAlpha[k] += fUpper / prob;
      if (k > 0) gAlpha[k - 1] -= fLower / prob;
    }
    if (useRandomIntercept) {
      for (let g = 0; g < nG; g++) gB[g] -= b[g] / Math.max(sigma2, 1e-6);
    }
    if (ridgeLambda > 0) {
      for (let j = 0; j < p; j++) gBeta[j] -= ridgeLambda * beta[j];
    }
    return { gAlpha, gBeta, gB };
  }

  // ========== Model fitting ==========
  // Cumulative-logit ordinal model with optional weekday random intercept.
  //
  // Threshold reparameterization (#3): α₀ free, α_j = α_{j-1} + exp(δ_{j-1}).
  // This guarantees α₁ < α₂ < … < α_{K-2} without the hard clip that used to
  // break the gradient direction.
  //
  // Optimizer (#5): Adam over the joint vector [α₀, δ, β, b]. Convergence is
  // declared when the relative change in penalized log-likelihood between two
  // checkpoints falls below 1e-7. The final `converged` flag is exposed so the
  // UI can warn when fitting bailed out at maxIter.
  function fitOrdinalMixed(X, Y, groups, useRandomIntercept, regularization) {
    const levels = [...new Set(Y)].sort((a, b) => a - b);
    const K = levels.length;
    if (K < 2) return null;
    const yIdx = Y.map(y => levels.indexOf(y));
    const n = X.length, p = X[0].length;
    const uGroups = useRandomIntercept ? [...new Set(groups)] : [];
    const nG = uGroups.length;
    const gMap = {}; uGroups.forEach((g, i) => { gMap[g] = i; });
    const gIdx = useRandomIntercept ? groups.map(g => gMap[g]) : [];

    // Initialize α from empirical cumulative log-odds, then fold into (a0, δ).
    const empAlpha = [];
    for (let j = 0; j < K - 1; j++) {
      const cp = yIdx.filter(y => y <= j).length / n;
      const cpClip = Math.max(0.02, Math.min(0.98, cp));
      empAlpha.push(Math.log(cpClip / (1 - cpClip)));
    }
    let a0 = empAlpha[0];
    const delta = new Array(Math.max(K - 2, 0));
    for (let j = 1; j < K - 1; j++) {
      const diff = Math.max(empAlpha[j] - empAlpha[j - 1], 0.05);
      delta[j - 1] = Math.log(diff);
    }
    const buildAlpha = () => {
      const a = new Array(K - 1);
      a[0] = a0;
      for (let j = 1; j < K - 1; j++) a[j] = a[j - 1] + Math.exp(delta[j - 1]);
      return a;
    };

    let beta = new Array(p).fill(0);
    let b = new Array(nG).fill(0);
    let sigma2 = 0.5;
    const ridgeLambda = regularization.lambda;

    // Adam state in a single flat vector: [a0, δ_1..δ_{K-2}, β_1..β_p, b_1..b_nG].
    const dDim = Math.max(K - 2, 0);
    const numTheta = 1 + dDim + p + nG;
    const mAdam = new Float64Array(numTheta);
    const vAdam = new Float64Array(numTheta);
    const adamLR = 0.01, adamB1 = 0.9, adamB2 = 0.999, adamEps = 1e-8;

    let prevLL = -Infinity;
    let converged = false;
    const maxIter = 100000;
    const checkEvery = 10;
    let iterUsed = 0;

    for (let iter = 1; iter <= maxIter; iter++) {
      iterUsed = iter;
      const alpha = buildAlpha();
      const { gAlpha, gBeta, gB } = computeGradients(
        X, yIdx, K, alpha, beta, b, gIdx, sigma2, useRandomIntercept, ridgeLambda,
      );

      // Chain rule: ∂L/∂a₀ = Σ_j ∂L/∂α_j; ∂L/∂δ_m = exp(δ_m) · Σ_{j ≥ m} ∂L/∂α_j.
      let gA0 = 0;
      for (let j = 0; j < K - 1; j++) gA0 += gAlpha[j];
      const gDelta = new Float64Array(dDim);
      let suffix = 0;
      for (let j = K - 2; j >= 1; j--) {
        suffix += gAlpha[j];
        gDelta[j - 1] = Math.exp(delta[j - 1]) * suffix;
      }

      const bc1 = 1 - Math.pow(adamB1, iter);
      const bc2 = 1 - Math.pow(adamB2, iter);
      const adamStep = (idx, g) => {
        mAdam[idx] = adamB1 * mAdam[idx] + (1 - adamB1) * g;
        vAdam[idx] = adamB2 * vAdam[idx] + (1 - adamB2) * g * g;
        const mh = mAdam[idx] / bc1;
        const vh = vAdam[idx] / bc2;
        return adamLR * mh / (Math.sqrt(vh) + adamEps);
      };

      a0 += adamStep(0, gA0);
      for (let j = 0; j < dDim; j++) delta[j] += adamStep(1 + j, gDelta[j]);
      for (let j = 0; j < p; j++) beta[j] += adamStep(1 + dDim + j, gBeta[j]);
      if (useRandomIntercept) {
        for (let g = 0; g < nG; g++) b[g] += adamStep(1 + dDim + p + g, gB[g]);
      }

      // Random-intercept variance update via empirical Bayes (n-1 denominator).
      if (useRandomIntercept && iter % 25 === 0) {
        let ss = 0; for (let g = 0; g < nG; g++) ss += b[g] * b[g];
        sigma2 = Math.max(ss / Math.max(nG - 1, 1), 0.01);
      }

      if (iter % checkEvery === 0) {
        const ll = penalizedLogLik(
          X, yIdx, K, buildAlpha(), beta, b, gIdx, sigma2, useRandomIntercept, ridgeLambda,
        );
        if (Number.isFinite(prevLL) && Math.abs(ll - prevLL) < 1e-7 * Math.max(Math.abs(prevLL), 1)) {
          prevLL = ll;
          converged = true;
          break;
        }
        prevLL = ll;
      }
    }

    const alpha = buildAlpha();
    let logLik = 0;
    for (let i = 0; i < n; i++) {
      let eta = useRandomIntercept ? b[gIdx[i]] : 0;
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      logLik += logOrdProb(yIdx[i], K, alpha, eta);
    }
    const numParams = (K - 1) + p + (useRandomIntercept ? 1 : 0);
    const aic = -2 * logLik + 2 * numParams;
    const oddsRatios = beta.map(bv => Math.exp(bv));

    // McFadden pseudo-R² (#4): null model is the intercept-only ordinal model
    // whose MLE for P(Y=k) is the empirical marginal frequency. Not the fitted α.
    const counts = new Array(K).fill(0);
    yIdx.forEach(k => counts[k]++);
    let llNull = 0;
    counts.forEach(c => { if (c > 0) llNull += c * Math.log(c / n); });
    const pseudoR2 = llNull < 0 ? 1 - logLik / llNull : 0;

    // Wald SE for β (#6): inverse of the observed-information Hessian at MLE.
    let seBeta = null, ciBetaLow = null, ciBetaHigh = null;
    let ciOrLow = null, ciOrHigh = null;
    let zStat = null, pValue = null;
    if (p > 0) {
      const Hbeta = computeBetaHessian(
        X, yIdx, K, alpha, beta, b, gIdx, useRandomIntercept, ridgeLambda,
      );
      const Hinv = invertMatrix(Hbeta);
      if (Hinv) {
        seBeta = new Array(p);
        ciBetaLow = new Array(p);
        ciBetaHigh = new Array(p);
        ciOrLow = new Array(p);
        ciOrHigh = new Array(p);
        zStat = new Array(p);
        pValue = new Array(p);
        for (let j = 0; j < p; j++) {
          const v = Math.max(Hinv[j][j], 0);
          const se = Math.sqrt(v);
          seBeta[j] = se;
          ciBetaLow[j] = beta[j] - 1.96 * se;
          ciBetaHigh[j] = beta[j] + 1.96 * se;
          ciOrLow[j] = Math.exp(ciBetaLow[j]);
          ciOrHigh[j] = Math.exp(ciBetaHigh[j]);
          const z = se > 0 ? beta[j] / se : 0;
          zStat[j] = z;
          pValue[j] = 2 * (1 - normalCdf(Math.abs(z)));
        }
      }
    }

    const dayLabels = ['日', '一', '二', '三', '四', '五', '六'];
    const randomEffects = uGroups.map((g, i) => ({ day: dayLabels[g], value: b[i] }));

    return {
      beta: Array.from(beta),
      oddsRatios,
      alpha,
      sigma2,
      logLik,
      aic,
      pseudoR2,
      n, p, K, levels, randomEffects,
      useRandomIntercept,
      numParams,
      converged,
      iterUsed,
      seBeta,
      ciBetaLow,
      ciBetaHigh,
      ciOrLow,
      ciOrHigh,
      zStat,
      pValue,
    };
  }

  // Standard normal CDF via Abramowitz & Stegun rational approximation 26.2.17.
  // Sufficient accuracy for converting Wald z-statistics to two-sided p-values.
  function normalCdf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return 0.5 * (1 + sign * y);
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

  function fitLinearRegression(X, Y, regularization) {
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
    for (let j = 1; j < q; j++) xtx[j][j] += regularization.lambda;

    // solveLinearSystem allocates its own augmented copy, so xtx survives.
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

    // ML σ² (sse/n) feeds the Gaussian log-likelihood and AIC.
    // Unbiased σ² (sse / dof) feeds the reported RMSE and Wald SE.
    const sigma2ML = Math.max(sse / n, 1e-9);
    const dofResid = Math.max(n - q, 1);
    const sigma2Unbiased = Math.max(sse / dofResid, 1e-9);
    const logLik = -0.5 * n * (Math.log(2 * Math.PI * sigma2ML) + 1);
    const numParams = q + 1;
    const r2 = sst > 0 ? 1 - sse / sst : 0;
    const r2Adj = sst > 0 && dofResid > 0
      ? 1 - (sse / dofResid) / (sst / Math.max(n - 1, 1))
      : 0;

    // Naïve ridge SE: Var(β) ≈ σ² · (X'X + λI)⁻¹. With λ=0 this collapses to the
    // standard OLS formula. With λ>0 it is the conditional SE of the penalized
    // estimate — it ignores ridge bias but is what users expect from a "ridge SE".
    let seBeta = null, ciBetaLow = null, ciBetaHigh = null;
    let zStat = null, pValue = null;
    const xtxInv = invertMatrix(xtx);
    if (xtxInv) {
      seBeta = new Array(p);
      ciBetaLow = new Array(p);
      ciBetaHigh = new Array(p);
      zStat = new Array(p);
      pValue = new Array(p);
      for (let j = 0; j < p; j++) {
        const v = Math.max(xtxInv[j + 1][j + 1] * sigma2Unbiased, 0);
        const se = Math.sqrt(v);
        seBeta[j] = se;
        ciBetaLow[j] = coef[j + 1] - 1.96 * se;
        ciBetaHigh[j] = coef[j + 1] + 1.96 * se;
        const z = se > 0 ? coef[j + 1] / se : 0;
        zStat[j] = z;
        pValue[j] = 2 * (1 - normalCdf(Math.abs(z)));
      }
    }

    return {
      beta: coef.slice(1),
      intercept: coef[0],
      r2,
      r2Adj,
      rmse: Math.sqrt(sigma2Unbiased),
      logLik,
      aic: -2 * logLik + 2 * numParams,
      n,
      p,
      numParams,
      converged: true,
      seBeta,
      ciBetaLow,
      ciBetaHigh,
      zStat,
      pValue,
    };
  }

  // ========== Rendering ==========

  // Dynamically adjust the chart container height based on the number of features.
  // Each row gets ~34 px of space; add fixed overhead for title, axes, padding.
  function setChartHeight(featureCount) {
    const container = document.querySelector('.analysis-chart-container');
    if (!container) return;
    const perRow = 34;        // px per feature bar
    const overhead = 100;     // title + x-axis + padding
    const minH = 320;
    const maxH = 900;
    const h = Math.min(maxH, Math.max(minH, featureCount * perRow + overhead));
    container.style.height = h + 'px';
  }

  const TYPE_COLORS = {
    taken: { pos: ['rgba(85,239,196,0.75)', '#55efc4'], neg: ['rgba(225,112,85,0.75)', '#e17055'] },
    offset: { pos: ['rgba(116,185,255,0.75)', '#74b9ff'], neg: ['rgba(253,203,110,0.75)', '#fdcb6e'] },
    dose: { pos: ['rgba(0,206,201,0.75)', '#00cec9'], neg: ['rgba(214,48,49,0.65)', '#d63031'] },
    event: { pos: ['rgba(253,121,168,0.75)', '#fd79a8'], neg: ['rgba(99,110,114,0.65)', '#636e72'] },
    sleep: { pos: ['rgba(162,155,254,0.75)', '#a29bfe'], neg: ['rgba(255,234,167,0.75)', '#ffeaa7'] },
    bio: { pos: ['rgba(129,236,236,0.75)', '#81ecec'], neg: ['rgba(255,118,117,0.75)', '#ff7675'] },
  };

  function getColor(type, value) {
    const c = TYPE_COLORS[type] || TYPE_COLORS.sleep;
    return value >= 0 ? c.pos : c.neg;
  }

  function renderChart(featureNames, featureTypes, weights, oddsRatios, randomEffects, modelInfo) {
    setChartHeight(featureNames.length);
    const ctx = document.getElementById('analysis-chart').getContext('2d');
    if (chart) chart.destroy();
    const isOrdinal = modelInfo.modelType === 'ordinal';
    const unit = modelInfo.target.unit ? ` ${modelInfo.target.unit}` : '';
    const bgColors = weights.map((w, i) => getColor(featureTypes[i], w)[0]);
    const borderColors = weights.map((w, i) => getColor(featureTypes[i], w)[1]);
    const ridgeText = modelInfo.regularization.enabled ? `Ridge λ=${modelInfo.regularization.lambda}` : '无系数正则化';

    const titleText = isOrdinal
      ? `累积Logit ▸ ${ridgeText} ▸ N=${modelInfo.n}`
      : `线性回归 ▸ ${ridgeText} ▸ 目标：${modelInfo.target.label} · R² ${(modelInfo.r2 * 100).toFixed(1)}% · RMSE ${modelInfo.rmse.toFixed(2)}${unit}`;

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
                const idx = tip.dataIndex;
                const v = tip.parsed.x;
                const lines = [`系数: ${v >= 0 ? '+' : ''}${v.toFixed(4)}`];
                if (modelInfo.seBeta && Number.isFinite(modelInfo.seBeta[idx])) {
                  lines.push(`SE: ${modelInfo.seBeta[idx].toFixed(4)}`);
                  lines.push(`95% CI: [${modelInfo.ciBetaLow[idx].toFixed(3)}, ${modelInfo.ciBetaHigh[idx].toFixed(3)}]`);
                }
                if (modelInfo.pValue && Number.isFinite(modelInfo.pValue[idx])) {
                  const pv = modelInfo.pValue[idx];
                  const pTxt = pv < 0.001 ? 'p < 0.001' : `p = ${pv.toFixed(3)}`;
                  const sig = pv < 0.05 ? ' ✱' : '';
                  lines.push(`${pTxt}${sig}`);
                }
                if (isOrdinal) {
                  const or = oddsRatios[idx];
                  lines.push(`OR: ${or.toFixed(3)}`);
                  if (modelInfo.ciOrLow) {
                    lines.push(`OR 95% CI: [${modelInfo.ciOrLow[idx].toFixed(2)}, ${modelInfo.ciOrHigh[idx].toFixed(2)}]`);
                  }
                } else {
                  lines.push(`目标: ${modelInfo.target.label}`);
                }
                return lines;
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
      plugins: [
        {
          id: 'errorBars',
          // Wald 95% CI for each coefficient. Bars whose CI crosses zero (i.e.
          // not significant at α=0.05) are drawn dimmer so the eye discounts them.
          afterDatasetsDraw(ch) {
            if (!modelInfo.ciBetaLow || !modelInfo.ciBetaHigh) return;
            const { ctx, scales: { x, y } } = ch;
            ctx.save();
            ctx.lineWidth = 1.5;
            modelInfo.ciBetaLow.forEach((lo, idx) => {
              const hi = modelInfo.ciBetaHigh[idx];
              if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
              const yPos = y.getPixelForValue(idx);
              const xLo = x.getPixelForValue(lo);
              const xHi = x.getPixelForValue(hi);
              const significant = lo > 0 || hi < 0;
              ctx.strokeStyle = significant ? 'rgba(232,236,244,0.85)' : 'rgba(232,236,244,0.35)';
              ctx.beginPath();
              ctx.moveTo(xLo, yPos); ctx.lineTo(xHi, yPos);
              ctx.moveTo(xLo, yPos - 4); ctx.lineTo(xLo, yPos + 4);
              ctx.moveTo(xHi, yPos - 4); ctx.lineTo(xHi, yPos + 4);
              ctx.stroke();
            });
            ctx.restore();
          },
        },
        {
          id: 'weightLabels',
          afterDatasetsDraw(ch) {
            const { ctx, data, scales: { x, y } } = ch;
            ctx.save();
            data.datasets[0].data.forEach((value, index) => {
              const xPos = x.getPixelForValue(value), yPos = y.getPixelForValue(index);
              const sign = value >= 0 ? '+' : '';
              const suffix = isOrdinal ? ` (OR ${oddsRatios[index].toFixed(2)})` : '';
              const significant = modelInfo.ciBetaLow
                && (modelInfo.ciBetaLow[index] > 0 || modelInfo.ciBetaHigh[index] < 0);
              ctx.fillStyle = significant ? '#ffffff' : '#e8ecf4';
              ctx.font = significant ? '700 11px Inter, sans-serif' : '600 11px Inter, sans-serif';
              ctx.textBaseline = 'middle';
              ctx.textAlign = value >= 0 ? 'left' : 'right';
              // Push label past the CI whisker if there is one, so it never overlaps.
              let labelOffset = value >= 0 ? 6 : -6;
              if (modelInfo.ciBetaHigh && Number.isFinite(modelInfo.ciBetaHigh[index])) {
                const tip = value >= 0 ? modelInfo.ciBetaHigh[index] : modelInfo.ciBetaLow[index];
                const tipPos = x.getPixelForValue(tip);
                labelOffset = (tipPos - xPos) + (value >= 0 ? 6 : -6);
              }
              ctx.fillText(`${sign}${value.toFixed(3)}${suffix}`, xPos + labelOffset, yPos);
            });
            ctx.restore();
          },
        },
      ],
    });
  }

  function renderEmpty(msg) {
    setChartHeight(0); // reset to minimum height when empty
    const ctx = document.getElementById('analysis-chart').getContext('2d');
    if (chart) { chart.destroy(); chart = null; }
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#5a6480'; ctx.font = '16px Inter, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(msg, ctx.canvas.width / 2, ctx.canvas.height / 2);
  }

  function renderStats(stats) {
    const el = document.getElementById('analysis-stats');
    if (!stats) { el.innerHTML = ''; return; }
    const ridgeDesc = stats.regularization.enabled ? `Ridge λ=${stats.regularization.lambda}` : '无Ridge';
    const convergedTag = stats.converged === false
      ? `<span style="color:var(--accent3)">⚠ 未收敛(${stats.iterUsed}步)</span>`
      : (stats.iterUsed ? `已收敛(${stats.iterUsed}步)` : '');
    const droppedTag = stats.droppedFeatures && stats.droppedFeatures.length
      ? `<span class="stat-desc" style="color:var(--accent4)">已剔除零方差: ${stats.droppedFeatures.join('、')}</span>`
      : '';
    if (stats.modelType === 'continuous') {
      const r2Pct = (stats.r2 * 100).toFixed(1);
      const r2AdjPct = stats.r2Adj != null ? (stats.r2Adj * 100).toFixed(1) : null;
      const r2Color = stats.r2 > 0.3 ? 'var(--accent5)' : stats.r2 > 0.1 ? 'var(--accent4)' : 'var(--accent3)';
      const unit = stats.target.unit ? ` ${stats.target.unit}` : '';
      const r2Desc = r2AdjPct != null ? `调整 R² ${r2AdjPct}%` : '';
      el.innerHTML = `
        <div class="stat-card"><span class="stat-label">R²</span><span class="stat-value" style="color:${r2Color}">${r2Pct}%</span><span class="stat-desc">${r2Desc}</span></div>
        <div class="stat-card"><span class="stat-label">RMSE</span><span class="stat-value">${stats.rmse.toFixed(2)}</span><span class="stat-desc">${stats.target.label}${unit}</span></div>
        <div class="stat-card"><span class="stat-label">LL / AIC</span><span class="stat-value">${stats.logLik.toFixed(0)}</span><span class="stat-desc">AIC ${stats.aic.toFixed(0)}</span></div>
        <div class="stat-card"><span class="stat-label">N</span><span class="stat-value">${stats.n}</span><span class="stat-desc">${stats.p}特征 ${ridgeDesc}</span></div>
        ${droppedTag}`;
      return;
    }
    const r2Pct = (stats.pseudoR2 * 100).toFixed(1);
    const r2Color = stats.pseudoR2 > 0.3 ? 'var(--accent5)' : stats.pseudoR2 > 0.1 ? 'var(--accent4)' : 'var(--accent3)';
    el.innerHTML = `
      <div class="stat-card"><span class="stat-label">R²</span><span class="stat-value" style="color:${r2Color}">${r2Pct}%</span><span class="stat-desc">McFadden</span></div>
      <div class="stat-card"><span class="stat-label">LL / AIC</span><span class="stat-value">${stats.logLik.toFixed(0)}</span><span class="stat-desc">AIC ${stats.aic.toFixed(0)}</span></div>
      <div class="stat-card"><span class="stat-label">模型</span><span class="stat-value">Logit</span><span class="stat-desc">累积链接</span></div>
      <div class="stat-card"><span class="stat-label">N</span><span class="stat-value">${stats.n}</span><span class="stat-desc">${stats.p}特征 ${stats.K}级 ${ridgeDesc} ${convergedTag}</span></div>
      ${droppedTag}`;
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
  return { init, refresh, toggleGroup, toggleOutlierInclusion, setWindow, setStartDate, setTarget };
})();
