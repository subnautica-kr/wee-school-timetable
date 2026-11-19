# 개발

Node 22 이상(`package.json` 의 `engines`)과 PostgreSQL 16 이 필요하다.

## 개발 DB 띄우기

`docker-compose.yml` 의 `db` 서비스가 개발용 PostgreSQL 이다(호스트 `127.0.0.1:55432`, 사용자·DB 이름 `timetable`).

```
docker compose up -d db
export DATABASE_URL=postgres://timetable:timetable-dev@127.0.0.1:55432/timetable
export SESSION_SECRET=dev-only-change-me
export COOKIE_SECURE=false
npm install
npm run migrate
```

`npm run migrate` 는 `server/schema.sql` 과 `server/migrations/*.sql` 을 이름 순으로 적용한다. 여러 번 돌려도 안전하다(`server/migrate.js`).

## 서버와 웹 개발 서버

```
npm run seed:admin        # ADMIN_LOGIN_ID 환경변수 필요(docs/configuration.md)
node server/index.js      # API 서버 :3000
npm --prefix web install
npm --prefix web run dev  # Vite 개발 서버
```

Vite 는 `/api` 를 `http://127.0.0.1:3000` 으로 넘긴다(`web/vite.config.js`). `docker compose up` 으로 앱까지 한 번에 띄울 수도 있다. 이때는 `Dockerfile` 이 화면을 빌드해 서버가 `web/dist` 를 낸다.

견본 자료(여덟 명의 교사가 있는 학교 하나)는 `node scripts/seed-sample.js` 로 만든다.

## npm scripts

| 명령 | 하는 일 |
|---|---|
| `npm start` | 마이그레이션 후 서버 시작 |
| `npm run migrate` | 스키마 적용 |
| `npm run seed:admin` | 시스템 관리자 계정 만들기(`scripts/seed-admin.js`) |
| `npm run check` | `server/index.js`·`server/app.js` 문법 검사 |
| `npm test` | `node --test --test-concurrency=1 test/*.test.js` |
| `npm run build:web` | 웹 의존성 설치 후 빌드(`web/` 의 `vite build` 와 `scripts/precompress.js` 로 미리 압축) |

그 밖의 스크립트: `scripts/bench-gen.js`(생성기 시간 재기, `node scripts/bench-gen.js [후보 수] [후보당 ms]`), `scripts/load/`(부하 시험, `README.md` 참고), `scripts/ship.sh`(배포 묶음 만들기).

## 시험

- `npm test` 는 `node:test` 를 쓰고, 파일끼리 DB 를 공유하므로 동시 실행하지 않는다(`--test-concurrency=1`).
- **대부분의 시험은 DB 가 필요하다.** `DATABASE_URL`(또는 `DATABASE_URL_FILE`)이 없으면 그 시험은 건너뛴다(`HAS_DB`). 시험은 스스로 `migrate` 를 돌리고, 태그를 붙인 자기 기관 자료만 만들어 끝에 지운다(`test/sec-helpers.js`).
- 시험은 앱을 임의 포트로 따로 띄우므로 실행 중인 서버와 부딪히지 않는다.
- 시험 하나만: `node --test test/auth.test.js`.
- DB 없이 도는 시험: 생성기·겹침·권장 규칙·화면 순수 함수 등(`test/soft.test.js`, `test/overlap-table.test.js` 등).

## 코드 꼴 관례

코드에서 보이는 것만 적는다.

- ES 모듈(`"type": "module"`). 서버는 의존성 외에 빌드 단계가 없다.
- 라우터는 `xxxRouter(pool)` 를 내보내는 함수이고 `server/app.js` 에서 `/api/orgs/:orgId` 아래 붙인다. 기관 안 경로는 `requireOrgAction(동작)` → 매개변수 쿼리(`org_id = req.orgId`, `deleted_at IS NULL`) → 없거나 남의 기관이면 404 순서이다(`server/routes/org.js` 머리 주석).
- 새 권한 동작은 `server/permissions.js` 의 표에만 더한다.
- 입력은 zod 로 검사하고 틀리면 `400 {error}` 이다.
- 지우기는 `deleted_at` 표시 삭제이고, DB 제약은 「같은 것이 둘」 방지 유일 인덱스로 한정한다. 업무 규칙 위반(교사·특별실 겹침 등)은 거부하지 않고 목록으로 돌려준다(`server/schema.sql`, `server/violations.js`, `server/rules.js`).
- 기관마다 다른 값의 기본값은 `server/orgConfig.js` 한 곳에 두고 `org.config` 가 덮는다.
- 스키마 변경은 `server/migrations/NNN_이름.sql` 새 파일로 더하고 `IF NOT EXISTS` 같은 멱등 꼴로 쓴다(`server/migrate.js` 주석).
- 기관 안 변경은 `audit()`(`server/audit.js`)로 감사 기록을 남긴다.
- 서버와 화면이 같이 쓰는 순수 로직은 `shared/` 에 둔다.
- 화면은 React 함수 컴포넌트(`.jsx`)와 Mantine 이고 기능별 폴더로 나눈다. API 호출은 `web/src/api.js` 의 `api(method, path, body)` 로 하고 CSRF 헤더를 자동으로 붙인다.
- 생성기(`web/src/gen/`)는 DOM·fetch 에 기대지 않는 순수 함수로 두어 웹 워커와 node(`scripts/bench-gen.js`, 시험)에서 같이 쓴다.
- 주석과 사용자에게 보이는 문구는 한국어이다.
