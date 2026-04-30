'use strict';
const { logOrdProb, invertMatrix, solveLinearSystem, normalCdf, sigmoid } = require('./mathUtils');
const { computeGradients, computeBetaHessian } = require('./computeGradients');

function fitOrdinalMixed(X, Y, groups, useRandomIntercept, regularization) {
  const levels = [...new Set(Y)].sort((a, b) => a - b);
  const K = levels.length;
  if (K < 2) return null;
  const yIdx = Y.map(y => levels.indexOf(y));
  const n = X.length, p = X[0].length;
  const uGroups = useRandomIntercept ? [...new Set(groups)] : [];
  const nG = uGroups.length;
  const gMap = {};
  uGroups.forEach((g, i) => { gMap[g] = i; });
  const gIdx = useRandomIntercept ? groups.map(g => gMap[g]) : [];

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

  const penalizedLogLik = () => {
    const alpha = buildAlpha();
    let ll = 0;
    for (let i = 0; i < n; i++) {
      let eta = useRandomIntercept ? b[gIdx[i]] : 0;
      for (let j = 0; j < p; j++) eta += X[i][j] * beta[j];
      ll += logOrdProb(yIdx[i], K, alpha, eta);
    }
    if (useRandomIntercept)
      for (let g = 0; g < b.length; g++) ll -= 0.5 * b[g] * b[g] / Math.max(sigma2, 1e-6);
    if (ridgeLambda > 0)
      for (let j = 0; j < p; j++) ll -= 0.5 * ridgeLambda * beta[j] * beta[j];
    return ll;
  };

  for (let iter = 1; iter <= maxIter; iter++) {
    iterUsed = iter;
    const alpha = buildAlpha();
    const { gAlpha, gBeta, gB } = computeGradients(X, yIdx, K, alpha, beta, b, gIdx, sigma2, useRandomIntercept, ridgeLambda);
    let gA0 = 0;
    for (let j = 0; j < K - 1; j++) gA0 += gAlpha[j];
    const gDelta = new Float64Array(dDim);
    let suffix = 0;
    for (let j = K - 2; j >= 1; j--) { suffix += gAlpha[j]; gDelta[j - 1] = Math.exp(delta[j - 1]) * suffix; }
    const bc1 = 1 - Math.pow(adamB1, iter);
    const bc2 = 1 - Math.pow(adamB2, iter);
    const adamStep = (idx, g) => {
      mAdam[idx] = adamB1 * mAdam[idx] + (1 - adamB1) * g;
      vAdam[idx] = adamB2 * vAdam[idx] + (1 - adamB2) * g * g;
      return adamLR * (mAdam[idx] / bc1) / (Math.sqrt(vAdam[idx] / bc2) + adamEps);
    };
    a0 += adamStep(0, gA0);
    for (let j = 0; j < dDim; j++) delta[j] += adamStep(1 + j, gDelta[j]);
    for (let j = 0; j < p; j++) beta[j] += adamStep(1 + dDim + j, gBeta[j]);
    if (useRandomIntercept)
      for (let g = 0; g < nG; g++) b[g] += adamStep(1 + dDim + p + g, gB[g]);
    if (useRandomIntercept && iter % 25 === 0) {
      let ss = 0; for (let g = 0; g < nG; g++) ss += b[g] * b[g];
      sigma2 = Math.max(ss / Math.max(nG - 1, 1), 0.01);
    }
    if (iter % checkEvery === 0) {
      const ll = penalizedLogLik();
      if (Number.isFinite(prevLL) && Math.abs(ll - prevLL) < 1e-7 * Math.max(Math.abs(prevLL), 1)) {
        prevLL = ll; converged = true; break;
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
  const counts = new Array(K).fill(0);
  yIdx.forEach(k => counts[k]++);
  let llNull = 0;
  counts.forEach(c => { if (c > 0) llNull += c * Math.log(c / n); });
  const pseudoR2 = llNull < 0 ? 1 - logLik / llNull : 0;

  let seBeta = null, ciBetaLow = null, ciBetaHigh = null, ciOrLow = null, ciOrHigh = null, zStat = null, pValue = null;
  if (p > 0) {
    const Hbeta = computeBetaHessian(X, yIdx, K, alpha, beta, b, gIdx, useRandomIntercept, ridgeLambda);
    const Hinv = invertMatrix(Hbeta);
    if (Hinv) {
      seBeta = []; ciBetaLow = []; ciBetaHigh = []; ciOrLow = []; ciOrHigh = []; zStat = []; pValue = [];
      for (let j = 0; j < p; j++) {
        const se = Math.sqrt(Math.max(Hinv[j][j], 0));
        seBeta.push(se);
        ciBetaLow.push(beta[j] - 1.96 * se);
        ciBetaHigh.push(beta[j] + 1.96 * se);
        ciOrLow.push(Math.exp(beta[j] - 1.96 * se));
        ciOrHigh.push(Math.exp(beta[j] + 1.96 * se));
        const z = se > 0 ? beta[j] / se : 0;
        zStat.push(z);
        pValue.push(2 * (1 - normalCdf(Math.abs(z))));
      }
    }
  }

  const dayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  const randomEffects = uGroups.map((g, i) => ({ day: dayLabels[g], value: b[i] }));
  return { beta: Array.from(beta), oddsRatios, alpha, sigma2, logLik, aic, pseudoR2, n, p, K, levels, randomEffects, useRandomIntercept, numParams, converged, iterUsed, seBeta, ciBetaLow, ciBetaHigh, ciOrLow, ciOrHigh, zStat, pValue };
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
      for (let bb = 0; bb < q; bb++) xtx[a][bb] += row[a] * row[bb];
    }
  }
  for (let j = 1; j < q; j++) xtx[j][j] += regularization.lambda;
  const coef = solveLinearSystem(xtx, xty);
  if (!coef) return null;
  const meanY = Y.reduce((s, y) => s + y, 0) / n;
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    let pred = coef[0];
    for (let j = 0; j < p; j++) pred += X[i][j] * coef[j + 1];
    sse += (Y[i] - pred) ** 2; sst += (Y[i] - meanY) ** 2;
  }
  const sigma2ML = Math.max(sse / n, 1e-9);
  const dofResid = Math.max(n - q, 1);
  const sigma2Unbiased = Math.max(sse / dofResid, 1e-9);
  const logLik = -0.5 * n * (Math.log(2 * Math.PI * sigma2ML) + 1);
  const numParams = q + 1;
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  const r2Adj = sst > 0 && dofResid > 0 ? 1 - (sse / dofResid) / (sst / Math.max(n - 1, 1)) : 0;
  let seBeta = null, ciBetaLow = null, ciBetaHigh = null, zStat = null, pValue = null;
  const xtxInv = invertMatrix(xtx);
  if (xtxInv) {
    seBeta = []; ciBetaLow = []; ciBetaHigh = []; zStat = []; pValue = [];
    for (let j = 0; j < p; j++) {
      const se = Math.sqrt(Math.max(xtxInv[j + 1][j + 1] * sigma2Unbiased, 0));
      seBeta.push(se); ciBetaLow.push(coef[j + 1] - 1.96 * se); ciBetaHigh.push(coef[j + 1] + 1.96 * se);
      const z = se > 0 ? coef[j + 1] / se : 0;
      zStat.push(z); pValue.push(2 * (1 - normalCdf(Math.abs(z))));
    }
  }
  return { beta: coef.slice(1), intercept: coef[0], r2, r2Adj, rmse: Math.sqrt(sigma2Unbiased), logLik, aic: -2 * logLik + 2 * numParams, n, p, numParams, converged: true, seBeta, ciBetaLow, ciBetaHigh, zStat, pValue };
}

module.exports = { fitOrdinalMixed, fitLinearRegression };
