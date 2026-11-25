// T-1322b③ 전출·일괄 연결·마지막 관리자 경고 화면의 순수 계산 — 시험: test/force-view.test.js

// 마지막 기관 관리자 경고(409 needConfirm + lastAdmin) 판별
export const isLastAdminErr = (e) => e?.status === 409 && !!e?.body?.needConfirm && !!e?.body?.lastAdmin;

// 경고 한 줄(서버가 문구를 채워 보낸다) — 없으면 빈 글
export const lastAdminText = (body) => (body?.warnings || []).map((w) => w.text).filter(Boolean).join(' ');

// 공용 도우미: 먼저 force 없이 보내 보고, 마지막 관리자 경고면 확인을 묻고(ask → true/false) 확인하면 force 로 같은 일을 다시 보낸다.
// fn(force) 는 요청을 보내는 함수. 확인을 거절하면 undefined 를 돌려준다(아무것도 안 바뀜).
export async function withForce(ask, fn) {
  try {
    return await fn(false);
  } catch (e) {
    if (!isLastAdminErr(e)) throw e;
    if (!(await ask(lastAdminText(e.body)))) return undefined;
    return fn(true);
  }
}

// ?force=1 붙이기(연결 해제 같은 본문 없는 길)
export const forcePath = (path, force) => (force ? `${path}${path.includes('?') ? '&' : '?'}force=1` : path);

// 여러 줄 한 번에 바꾸기 결과에서 마지막 관리자 깃발이 선 줄 { id, text }
export const flaggedRows = (results) => (results || []).filter((x) => x && !x.ok && x.needConfirm && x.lastAdmin)
  .map((x) => ({ id: x.id, text: lastAdminText(x) }));

// 일괄 연결 결과 → 세 묶음(연결됨 · 승인 대기 · 확인 필요)
export const bulkGroups = (results) => {
  const g = { linked: [], pending: [], check: [] };
  for (const x of results || []) (g[x.group] ?? g.check).push(x);
  return g;
};

// 일괄 연결에 보낼 줄 — 아이디를 채운 줄만(줄 번호 + 아이디)
export const bulkRowsOf = (ids) => Object.entries(ids)
  .map(([id, loginId]) => ({ membershipId: Number(id), loginId: String(loginId ?? '').trim() }))
  .filter((r) => r.loginId);

// 연결 응답 → 학교 옮기기 안내(전출 요청이 나갔나 · 그 자리에서 옮겨졌나). 보통 연결이면 null.
export const transferNote = (r) => {
  if (r?.transferRequested) return { kind: 'sent', loginId: r.loginId ?? '', expiresAt: r.expiresAt ?? null };
  if (r?.autoApproved) return { kind: 'auto', loginId: r.loginId ?? '', expiresAt: null };
  return null;
};

// 여러 줄 한 번에 바꾸기: 마지막 관리자 깃발이 섰던 줄을 force 로 다시 보낸 결과(second)를 첫 결과(first)에 합친다
export const mergeBulkStatus = (first, second) => {
  const redo = new Set((second.results || []).map((x) => x.id).filter((v) => v != null));
  const kept = (first.results || []).filter((x) => x.ok || !redo.has(x.id));
  const results = [...kept, ...(second.results || [])];
  return {
    ...first, results,
    changed: (first.changed || 0) + (second.changed || 0),
    failed: results.filter((x) => !x.ok).length,
    homeroom: (first.homeroom || 0) + (second.homeroom || 0),
    classes: (first.classes || 0) + (second.classes || 0),
  };
};
