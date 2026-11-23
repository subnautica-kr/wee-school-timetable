// 사용자가 본 마지막 버전을 브라우저에 둔다(localStorage 가 막힌 환경에서도 앱이 죽지 않게 감쌈).
const KEY = 'wee.seenVersion';
export const readSeenVersion = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const writeSeenVersion = (v) => { try { localStorage.setItem(KEY, v); } catch { /* 저장 못 해도 그 세션 표시만 사라진다 */ } };
