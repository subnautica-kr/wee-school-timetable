import { t } from '../shared/text/index.js';

// 서버 오류 보내기 — 문구 파일에서 골라 문장(error)으로 보내고 코드(code)·변수(vars)를 같이 싣는다.
// 화면(api.js)은 지금처럼 json.error 를 e.message 로 낸다. needConfirm·overlaps 같은 본문 깃발은 extra 로.
//   fail(res, 409, 'roster.err.already_linked', { 이름, 아이디 })
// 키는 그 영역 문구 파일의 err 묶음에 둔다(설계 1·4절).
export const makeFail = (tr) => (res, status, code, vars, extra) =>
  res.status(status).json({ error: tr(code, vars), code, vars, ...extra });
export const fail = makeFail(t);
