# 보안 설계

각 항목의 근거 파일을 함께 적는다. 취약점 신고는 `SECURITY.md` 를 본다.

## 세션

- 세션은 PostgreSQL `session` 표에 저장한다(`connect-pg-simple`, 15분마다 만료분 정리). 쿠키 이름은 `sid` 이고 `httpOnly`, `sameSite: 'lax'`, `secure`(기본 켜짐, `COOKIE_SECURE=false` 로만 끔)이다(`server/app.js`).
- `SESSION_SECRET` 은 쉼표로 여러 개를 받아 키를 돌려 쓸 수 있다.
- 로그인·기관 전환 때 세션 ID 를 새로 발급한다(`regenerate`, `server/routes/auth.js`). 「로그인 유지」를 고르면 30일, 아니면 브라우저를 닫을 때까지다.
- 비밀번호 변경·초기화, 역할 내림, 기관 중지 때 해당 세션을 서버에서 지운다(`killSessions`·`killOrgSessions`, `server/audit.js`; 호출은 `server/routes/auth.js`, `admin.js`, `roster.js`).

## CSRF

세션에 든 무작위 토큰을 `X-CSRF-Token` 헤더로 되돌려 받는다. GET·HEAD·OPTIONS 외 모든 요청에 적용하며 `timingSafeEqual` 로 비교하고, 틀리면 403 이다(`server/app.js`). 화면 쪽은 `web/src/api.js`.

## 비밀번호

- 저장: argon2id(`memoryCost 19456`, `timeCost 2`, `parallelism 1`, `server/accounts.js` 의 `ARGON`).
- 정책: 8자 이상 200자 이하, 흔한 비밀번호 1만 개 목록(`server/common-passwords.txt`, 소문자로 비교) 거부, ID 와 같은 값 거부. 그 밖의 구성 강제는 없다(`server/passwords.js`).
- 임시 비밀번호는 헷갈리는 글자를 뺀 무작위 8자이고 목록에 걸리면 다시 뽑는다. 임시 비밀번호로 만든 계정은 `must_change_password` 가 켜져 있어 비밀번호를 바꾸기 전에는 다른 API 가 403 이다(`server/guard.js`).
- 로그인 실패는 ID 없음·비밀번호 틀림·잠김·중지 기관을 같은 문구로 답하고, ID 가 없을 때도 더미 해시로 검증해 응답 시간 차이를 줄인다(`server/routes/auth.js`).
- 연속 10번 실패하면 15분 잠긴다(`MAX_FAILS`, `LOCK_MINUTES`).

## 요청 제한

`express-rate-limit`(`server/app.js`, `server/routes/auth.js`).

| 대상 | 한도 |
|---|---|
| `/api` 전체 | 1분 300회 |
| 로그인 | 15분 30회, 실패한 요청만 센다(학교 한 곳의 공유 IP 에서 성공 로그인이 한도를 먹지 않게) |
| 비밀번호 변경 | 15분 30회, 실패만 센다 |

클라이언트 IP 는 `TRUST_PROXY` 설정에 따라 정해진다(`docs/configuration.md`).

## HTTP 헤더

`helmet` 을 쓰고 CSP 는 `default-src 'self'`, 스타일 인라인 허용(Mantine 때문), 이미지 `self`·`data:`, 워커 `self`·`blob:` 이다. `x-powered-by` 는 끈다. `/api` 응답은 `Cache-Control: no-store` 이다(`server/app.js`). 오류 응답에는 스택을 싣지 않는다.

## 입력 검증

- 요청 본문 한도 1MB(`express.json`). NUL 문자(`\u0000`)가 든 본문·쿼리는 DB 오류를 막으려고 400 으로 거절한다(`server/app.js`).
- 경로별 입력은 zod 스키마로 검사하고 틀리면 400 이다(`server/routes/*.js`, 예: `auth.js`, `generate.js`).

## SQL

쿼리는 `pg` 의 매개변수(`$1`…)로만 값을 넣는다. 기관 안 쿼리는 URL 이 아니라 세션에서 온 `req.orgId` 로 `org_id` 를 건다(`server/guard.js`, `server/routes/org.js` 머리 주석). 문자열 이어붙이기가 없는지는 `test/sec-injection.test.js` 가 확인한다.

## 권한과 기관 경계

- 권한은 `server/permissions.js` 의 표 한 곳이 정본이다. 서버 검사가 방어선이고 화면의 버튼 숨김은 편의다.
- 다른 기관의 자료나 권한 밖 동작은 404 로 답해 존재 여부를 알리지 않는다(`server/guard.js`).
- 시스템 관리자는 기관 안 자료 동작을 갖지 않는다.
- 시험: `test/sec-privilege.test.js`, `test/org-boundary.test.js`, `test/sec-routes.test.js`(라우트 목록을 읽어 로그인·권한 검사 여부를 확인), `test/sec-session.test.js`, `test/sec-headers.test.js`, `test/sec-flood.test.js`, `test/sec-concurrency.test.js`, `test/sec-export.test.js`.

## 저장 데이터 암호화

보결 사유·근태 메모는 AES-256-GCM 으로 암호화해 DB 에 넣는다(`reason_enc`, `memo_enc`; `server/seal.js`). 키는 `DATA_KEY` 에서 HKDF 로 만든다.

## 감사 기록

중요한 변경(비밀번호 변경·기관 전환·명단·시간표 저장·확정·보결·특별실 예약·근태 등)은 `audit_log` 표에 누가·언제·무엇을·전/후 값을 남긴다(`server/audit.js` 의 `audit`, 호출 지점은 `server/routes/`). 기록 실패는 본 작업을 막지 않고 서버 로그만 남긴다. 기관 관리자(`audit.view`)가 `GET /api/orgs/:orgId/audit` 로 본다(`server/routes/audit-log.js`).
