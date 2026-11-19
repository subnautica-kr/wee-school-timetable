# 설정

서버·스크립트가 읽는 환경변수 전부다(`git grep -n 'process.env'` 기준). 시험이 읽거나 바꾸는 값은 맨 끝에 따로 적는다.

## 서버

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `DATABASE_URL` | 없음(필수) | PostgreSQL 접속 주소. 없으면 서버가 시작하지 못한다(`server/db.js`) |
| `SESSION_SECRET` | 없음(필수) | 세션 쿠키 서명 키. 쉼표로 여러 개를 주면 앞이 새 키, 뒤는 옛 키로 교체용이다(`server/app.js`) |
| `DATA_KEY` | `SESSION_SECRET` 의 첫 값 | DB 에 넣는 일부 글(보결 사유·근태 메모)을 AES-256-GCM 으로 암호화하는 키의 근원. 잃으면 그 칸을 열 수 없다(`server/seal.js`). 둘 다 없으면 시험용 고정값을 쓰므로 운영에서는 반드시 설정한다 |
| `<이름>_FILE` | 없음 | `DATABASE_URL`·`SESSION_SECRET`·`DATA_KEY` 는 값 대신 파일 경로를 `DATABASE_URL_FILE` 처럼 줄 수 있다. 파일이 있으면 그 내용(앞뒤 공백 제거)이 우선한다(`server/db.js` 의 `secret`) |
| `PORT` | `3000` | 서버가 듣는 포트(`server/index.js`) |
| `COOKIE_SECURE` | `true` | 세션 쿠키의 `Secure` 속성. `false` 라고 적을 때만 끈다. HTTPS 가 아닌 개발 환경용(`server/app.js`) |
| `TRUST_PROXY` | `1` | Express `trust proxy` 값. 숫자(프록시 단수) · `true` · `false` · `loopback` 같은 이름이나 주소 목록. 요청 제한이 클라이언트 IP 를 제대로 보려면 앞단 프록시 구성과 맞춘다(`server/app.js`) |
| `WEB_DIST` | `web/dist` | 빌드된 화면 파일 폴더(`server/app.js`) |

## 스크립트

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `ADMIN_LOGIN_ID` | 없음(필수) | `scripts/seed-admin.js` 가 만들 시스템 관리자의 ID |
| `ADMIN_PASSWORD` | 무작위 8자 | 그 계정의 임시 비밀번호. 첫 로그인 때 바꾸게 한다 |
| `ADMIN_NAME` | `ADMIN_LOGIN_ID` | 표시 이름 |
| `SAMPLE_PASSWORD` | 무작위 8자 | `scripts/seed-sample.js` 가 만드는 견본 계정들의 비밀번호 |
| `VUS` | `20` | `scripts/load/node-basic.js` 의 동시 사용자 수 |
| `SECS` | `30` | 같은 부하 시험의 지속 시간(초) |
| `OLD_HASH` | 없음 | `scripts/measure-hash.js` 에서 값이 있으면 argon2 옵션을 기본값으로 두고 잰다 |

DB 를 쓰는 스크립트는 `server/db.js` 를 거치므로 `DATABASE_URL`(또는 `_FILE`)이 필요하다.

## 배포용 compose 변수

환경변수가 아니라 `docker-compose` 가 `.env` 에서 치환하는 값이다(`docker-compose.yml`, `.env.example`).

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `DB_PASSWORD` | 없음(필수) | DB 컨테이너 비밀번호이자 앱의 `DATABASE_URL` 에 들어가는 값 |
| `BIND` | `127.0.0.1` | 앱 포트를 여는 주소 |
| `APP_PORT` | `3000` | 호스트 쪽 포트 |

`SESSION_SECRET`·`DATA_KEY`·`COOKIE_SECURE`·`TRUST_PROXY` 도 같은 `.env` 에서 앱 환경변수로 넘어간다. `DATABASE_URL` 은 compose 가 `DB_PASSWORD` 로 스스로 만들고, `PORT` 는 컨테이너 안에서 3000 으로 고정이다.

## 시험이 읽는 값

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `DATABASE_URL` · `DATABASE_URL_FILE` | 없음 | 있어야 DB 가 필요한 시험이 돈다. 없으면 그 시험은 건너뛴다(`test/*.test.js` 의 `HAS_DB`) |
| `WEB_DIST` · `TRUST_PROXY` · `COOKIE_SECURE` · `DATA_KEY` | — | 일부 시험이 값을 바꿔 가며 서버 동작을 확인한다 |
| `TZ` | — | `test/confirm-date-pins.test.js` 는 `Asia/Seoul` 로 고정한다 |
