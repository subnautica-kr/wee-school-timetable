// 앱 HTTP 길만 쓰는 작은 클라이언트 — 쿠키·CSRF 를 들고 다니고, 429(요청 한도)면 기다렸다 다시 친다.
// 비밀번호는 login() 인자로만 받고 어디에도 적지 않는다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeClient(baseUrl, { orgId, wait = sleep } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  let cookie = '';
  let csrf = '';
  const call = async (method, path, body) => {
    for (let tries = 0; ; tries++) {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.getSetCookie?.() ?? [];
      if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 빈 응답 */ }
      if (json?.csrf) csrf = json.csrf;
      if (res.status === 429 && tries < 5) {
        const s = Number(res.headers.get('retry-after') || res.headers.get('ratelimit-reset') || 10);
        await wait(Math.min(Math.max(s, 1), 70) * 1000);
        continue;
      }
      return { status: res.status, json, headers: res.headers };
    }
  };
  const ok = async (method, path, body, want = [200, 201]) => {
    const r = await call(method, path, body);
    if (!want.includes(r.status)) {
      const e = new Error(`${method} ${path} → ${r.status} ${r.json?.error ?? ''}`.trim());
      e.status = r.status;
      e.body = r.json;
      throw e;
    }
    return r.json;
  };
  const o = `/api/orgs/${orgId}`;
  return {
    call,
    ok,
    org: (p) => o + p,
    async login(loginId, password) {
      await call('GET', '/api/auth/session');
      const r = await call('POST', '/api/auth/login', { orgId: Number(orgId), loginId, password });
      if (r.status !== 200 || !r.json?.user) throw new Error(`로그인 실패(${r.status}) — 기관 번호·아이디·비밀번호를 확인해 주세요`);
      if (r.json.user.mustChange) throw new Error('이 계정은 비밀번호를 먼저 바꿔야 합니다 — 앱에서 바꾼 뒤 다시 돌려 주세요');
      if (r.json.user.role !== '기관관리자') throw new Error(`기관관리자 계정이어야 합니다(지금: ${r.json.user.role})`);
      return r.json.user;
    },
  };
}
