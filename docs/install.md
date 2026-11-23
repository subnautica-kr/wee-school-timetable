# 우리학교 시간표 (Wee School Timetable) 설치 안내

우리학교 시간표는 Node 22 + PostgreSQL 16 위에서 도는 웹앱입니다. 설치 방법은 세 가지입니다.

| 방법 | 맞는 경우 |
|---|---|
| 1. 도커 | 내 PC·서버에 Docker 가 있다. 가장 쉽다 |
| 2. 그냥 설치 | Docker 없이 Node 와 PostgreSQL 을 직접 쓴다 |
| 3. Render 무료 배포 | 서버 없이 맛보기로 인터넷에 올려 본다 |

## 1. 도커로 설치

필요한 것: Docker, `docker compose`(v2).

```bash
git clone https://github.com/subnautica-kr/wee-school-timetable.git
cd wee-school-timetable
cp .env.example .env
sed -i.bak "s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -hex 24)|; s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|; s|^DATA_KEY=.*|DATA_KEY=$(openssl rand -hex 32)|" .env && rm .env.bak
```

`http://` 로만 시험한다면 `.env` 의 `COOKIE_SECURE=true` 를 `false` 로 바꿉니다. HTTPS 로 운영할 때는 그대로 둡니다.

```bash
docker compose up -d --build
docker compose exec -e ADMIN_LOGIN_ID=admin -e ADMIN_NAME=관리자 app npm run seed:admin
```

마지막 명령이 임시 비밀번호를 한 번 보여 줍니다. 적어 두세요.
브라우저에서 `http://localhost:3000` 을 열고, 기관 「상위 기관」, ID `admin`, 임시 비밀번호로 로그인한 뒤 비밀번호를 바꿉니다.

- 기본은 이 PC 안에서만 열립니다. 다른 기기에서 접속하려면 `.env` 의 `BIND=0.0.0.0` 으로 바꾸고 `docker compose up -d` 를 다시 칩니다. 인터넷에 열 때는 HTTPS 프록시(Caddy, nginx 등) 뒤에 두세요.
- `DATA_KEY` 를 잃으면 암호화된 칸을 열 수 없습니다. `.env` 를 따로 보관하세요.
- 로그: `docker compose logs -f app` / 멈춤: `docker compose down` (`-v` 를 붙이면 DB 가 지워집니다).

## 2. 그냥 설치 (Docker 없이)

### 준비

- Node.js 22 이상 (`node -v` 로 확인)
- PostgreSQL 14 이상 (16 권장)
- Linux 또는 macOS 셸(bash). Windows 는 WSL 을 쓰세요.

DB 와 사용자를 만듭니다. 비밀번호는 바꿔서 쓰세요.

```bash
sudo -u postgres psql -c "CREATE USER timetable WITH PASSWORD 'change-me';"
sudo -u postgres psql -c "CREATE DATABASE timetable OWNER timetable;"
```

### 설치와 실행

```bash
git clone https://github.com/subnautica-kr/wee-school-timetable.git
cd wee-school-timetable
npm ci
npm run build:web
cp .env.example .env
```

`.env` 를 편집기로 열어 아래 세 값을 채웁니다. 나머지 줄은 지워도 됩니다.

```
DATABASE_URL=postgres://timetable:change-me@127.0.0.1:5432/timetable
SESSION_SECRET=(openssl rand -hex 32 의 결과)
DATA_KEY=(openssl rand -hex 32 의 결과)
```

http 로만 시험하면 `COOKIE_SECURE=false` 를, 프록시 없이 직접 열면 `TRUST_PROXY=0` 을 더합니다.

앱은 `.env` 를 스스로 읽지 않으므로 셸에 불러온 뒤 실행합니다.

```bash
set -a; . ./.env; set +a
npm run migrate
ADMIN_LOGIN_ID=admin ADMIN_NAME=관리자 npm run seed:admin
npm start
```

`seed:admin` 이 임시 비밀번호를 한 번 보여 줍니다. `http://localhost:3000`(`PORT` 로 바꿀 수 있음)에서 기관 「상위 기관」, ID `admin` 으로 로그인합니다. `npm start` 는 시작할 때 `migrate` 를 먼저 돌리므로, 업데이트 뒤에도 `npm start` 만 치면 됩니다.

계속 켜 두려면 systemd 나 pm2 같은 프로세스 관리자에 `npm start` 를 등록하세요(환경변수는 그쪽 설정에 넣습니다).

## 3. Render 무료 배포

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/subnautica-kr/wee-school-timetable)

1. 위 버튼을 누르고 Render 에 로그인한 뒤 「Apply」 합니다. 저장소의 `render.yaml` 대로 웹 서비스와 무료 Postgres 가 만들어지고, 비밀값은 자동 생성됩니다.
2. 빌드가 끝나면 `https://<서비스 이름>.onrender.com` 으로 열립니다.
3. 관리자 계정은 내 PC 에서 Render DB 에 붙어 만듭니다. Render 대시보드의 DB 화면에서 External Database URL 을 복사해 씁니다.

```bash
git clone https://github.com/subnautica-kr/wee-school-timetable.git
cd wee-school-timetable
npm ci
DATABASE_URL='(복사한 External Database URL)?ssl=true' ADMIN_LOGIN_ID=admin ADMIN_NAME=관리자 npm run seed:admin
```

무료 플랜의 한계:

- 15분 동안 접속이 없으면 서비스가 잠들고, 다시 열 때 깨는 데 1분쯤 걸립니다.
- 무료 DB 는 만든 지 30일 뒤에 만료됩니다. 계속 쓰려면 그 전에 백업(아래)을 받아 두거나 유료 플랜으로 올리세요.
- 맛보기용입니다. 실제 운영은 1번이나 2번을 권합니다.

## 4. 업데이트와 백업

백업을 먼저 받습니다.

```bash
# 도커
docker compose exec -T db pg_dump -U timetable timetable | gzip > backup-$(date +%F).sql.gz
# 그냥 설치
pg_dump "$DATABASE_URL" | gzip > backup-$(date +%F).sql.gz
```

복원(빈 DB 에):

```bash
gunzip -c backup-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U timetable timetable
```

`pg_dump` 가 없는 PC(예: 윈도우)에서는 node 도구로 통째 백업·복원합니다(저장소 폴더에서 `npm ci` 한 뒤). DB 주소는 비밀이라 환경변수로만 넣고 끝나면 지웁니다. 백업 파일에는 비밀번호 해시가 그대로 들어 있으니 안전한 곳에만 둡니다.

```powershell
# 백업
$env:DATABASE_URL = '<Render 의 External Database URL>'; node scripts/dump-db.js --out dbdump-before-011.json.gz; Remove-Item Env:DATABASE_URL
# 복원(빈 DB 에만 — 자료가 있으면 멈춥니다)
$env:DATABASE_URL = '<새 DB 의 URL>'; node scripts/restore-db.js dbdump-before-011.json.gz; Remove-Item Env:DATABASE_URL
```

업데이트:

```bash
git pull
docker compose up -d --build     # 도커
# 그냥 설치: npm ci && npm run build:web 후 npm start 를 다시 시작
```

시작할 때 DB 스키마가 자동으로 새 버전에 맞춰집니다. `.env`(특히 `DATA_KEY`)도 함께 보관하세요.

## 5. 자주 막히는 곳

| 증상 | 확인 |
|---|---|
| `DATABASE_URL 이 없다` | `.env` 를 불러오지 않았다. `set -a; . ./.env; set +a` 를 같은 셸에서 먼저 친다 |
| 로그인이 되는 것 같은데 바로 풀린다 | http 로 접속 중이다. `.env` 에 `COOKIE_SECURE=false` (운영은 HTTPS 를 쓴다) |
| `.env 에 DB_PASSWORD 가 필요` | `.env` 가 없거나 값이 비었다. 1번의 `sed` 줄을 다시 친다 |
| 화면이 안 뜨고 API 만 응답한다 | `npm run build:web` 을 안 했다(`web/dist` 가 없음) |
| 다른 기기에서 접속이 안 된다 | 도커는 `BIND=0.0.0.0`, 방화벽에서 포트 허용 |
| 포트 3000 이 이미 쓰인다 | `.env` 에 `APP_PORT`(도커) 또는 `PORT`(그냥 설치)를 바꾼다 |
| Render 에서 처음 열면 한참 걸린다 | 잠들었다 깨는 중이다. 1분쯤 기다린다 |
| 관리자 ID 를 또 만들었더니 「이미 있는 ID」 | 정상이다. 기존 계정은 건드리지 않는다 |

문제가 풀리지 않으면 GitHub 이슈로 남겨 주세요.
