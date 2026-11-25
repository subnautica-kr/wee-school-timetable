// 빠른 시작 교시 수 첫 값 — 학교 기본(/school/periods 의 grades[g].periods)이 먼저, 없는 학년은 예전 고정값(T-1305)
export const QUICK_PERIODS = { 1: 5, 2: 5, 3: 6, 4: 6, 5: 6, 6: 6 };
export function quickPeriods(cfg) {
  const out = { ...QUICK_PERIODS };
  for (const g of Object.keys(out)) { const n = Number(cfg?.grades?.[g]?.periods); if (Number.isInteger(n) && n >= 1 && n <= 10) out[g] = n; }
  return out;
}
