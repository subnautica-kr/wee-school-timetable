// 생년월일 숫자 8자리(YYYYMMDD) — 순수 함수. 화면 입력 칸과 서버 본문이 같은 꼴을 쓴다.

// 숫자만 남기고 8자리에서 자른다(붙여넣기 「1990-01-01」·전각 숫자도 받는다).
export function digitsOnly(s) {
  return String(s ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, '').slice(0, 8);
}

// 숫자 8자리이고 실제 있는 날짜(1900년 이후, 오늘 이전)인가
export function isBirth8(s, today = new Date()) {
  if (typeof s !== 'string' || !/^\d{8}$/.test(s)) return false;
  const y = Number(s.slice(0, 4)), m = Number(s.slice(4, 6)), d = Number(s.slice(6, 8));
  if (y < 1900) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return dt.getTime() <= Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
}

// 보여 주기용 1990-01-01
export function showBirth(s) {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : String(s ?? '');
}
