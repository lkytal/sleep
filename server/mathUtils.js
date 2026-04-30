'use strict';

function sigmoid(z) {
  if (z > 20) return 1 - 1e-9;
  if (z < -20) return 1e-9;
  return 1 / (1 + Math.exp(-z));
}

function logSigmoid(x) {
  if (x >= 0) return -Math.log1p(Math.exp(-x));
  return x - Math.log1p(Math.exp(x));
}

function logOrdProb(k, K, alpha, eta) {
  if (k === 0) return logSigmoid(alpha[0] - eta);
  if (k === K - 1) return logSigmoid(eta - alpha[K - 2]);
  const a = alpha[k] - eta;
  const b = alpha[k - 1] - eta;
  const logA = logSigmoid(a);
  const logB = logSigmoid(b);
  const ratio = Math.exp(logB - logA);
  if (ratio >= 1) return -700;
  return logA + Math.log1p(-ratio);
}

function ordProb(k, K, alpha, eta) {
  const upper = k < K - 1 ? sigmoid(alpha[k] - eta) : 1;
  const lower = k > 0 ? sigmoid(alpha[k - 1] - eta) : 0;
  return Math.max(upper - lower, 1e-12);
}

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

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

module.exports = { sigmoid, logSigmoid, logOrdProb, ordProb, invertMatrix, solveLinearSystem, normalCdf };
