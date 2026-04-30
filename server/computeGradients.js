'use strict';
const { sigmoid, ordProb } = require('./mathUtils');

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
    const hEta = d2P / P - (dP / P) * (dP / P);
    const w = -hEta;
    for (let jj = 0; jj < p; jj++) {
      const xij = X[i][jj];
      if (xij === 0) continue;
      const wxij = w * xij;
      for (let kk = jj; kk < p; kk++) H[jj][kk] += wxij * X[i][kk];
    }
  }
  for (let jj = 0; jj < p; jj++)
    for (let kk = jj + 1; kk < p; kk++) H[kk][jj] = H[jj][kk];
  if (ridgeLambda > 0)
    for (let j = 0; j < p; j++) H[j][j] += ridgeLambda;
  return H;
}

module.exports = { computeGradients, computeBetaHessian };
