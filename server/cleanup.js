// 정리 작업 틀(T-1320b) — 때가 되면 저절로 되는 일(7일 정리·만료·겸임 종료·30일 내보내기·90일 비우기)을 한 곳에 모은다.
// 돌리는 때: 서버가 깨어날 때 한 번 + 깨어 있는 동안 하루 한 번(요청마다 안 돈다 · 무료 서버는 잠들어 시계만 믿으면 건너뛴다).
// 만료의 바닥은 「지난 것은 읽을 때 이미 만료로 본다」이고 이 틀은 뒷정리다 — 일 하나가 실패해도 나머지는 돈다.
// 일은 각 판이 registerCleanup('<이름>', async (db, now) => 처리한 줄 수) 로 단다(모듈을 불러올 때 한 번).

const jobs = new Map();

export const DAY_MS = 24 * 60 * 60 * 1000;

export function registerCleanup(name, fn) {
  if (typeof fn !== 'function') throw new Error(`registerCleanup: ${name} is not a function`);
  jobs.set(name, fn); // 같은 이름이면 덮는다(모듈을 두 번 불러도 한 번만 돈다)
}
export const cleanupNames = () => [...jobs.keys()];
export const unregisterCleanup = (name) => jobs.delete(name);

// 등록된 일을 차례로 한 번씩 돌린다. 반환 [{ name, ok, count } | { name, ok: false, error }]
export async function runCleanups(db, { now = new Date(), log = console } = {}) {
  const out = [];
  for (const [name, fn] of jobs) {
    try {
      const count = await fn(db, now);
      out.push({ name, ok: true, count: Number(count) || 0 });
    } catch (e) {
      log.error?.(`cleanup ${name} failed`, e.message);
      out.push({ name, ok: false, error: e.message });
    }
  }
  return out;
}

// 깨어날 때 한 번 + 하루마다. 반환: 멈추는 함수. 타이머는 unref — 이것 때문에 프로세스가 안 끝나는 일은 없다.
export function startCleanups(db, { intervalMs = DAY_MS, log = console } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return; // 앞 판이 아직 돌면 건너뜀
    running = true;
    try { await runCleanups(db, { log }); } finally { running = false; }
  };
  const first = tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  stop.first = first;
  return stop;
}
