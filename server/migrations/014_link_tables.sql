-- 014(T-1320b) 새 표·계정 칸 — 계정 연결·가입 승인·전출·알림·도움·요청·오류 기록의 바닥.
-- 몇 번 돌려도 같은 결과(서버가 뜰 때마다 다시 돈다): 표·칸·색인은 IF NOT EXISTS, CHECK 는 표 안에만 건다.
-- 새 칸의 저장 값은 영어 코드(shared/codes.js) · 화면 낱말은 shared/text/labels.js.
-- 지우기는 표시 삭제(deleted_at)가 바닥이다. 처리된 승인 대기 줄은 평균 승인 시간 표본이라 지우지 않는다.

-- ── 계정(app_user) 새 칸 ─────────────────────────────
-- 휴면 = 연결된 줄 0 + dormant_at 이 찬 계정(상태 값으로 안 넣는다 — status 는 사용·잠김 그대로)
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS birth_date      DATE;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS signed_up_at    TIMESTAMPTZ;  -- 본인이 가입한 계정만
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS first_linked_at TIMESTAMPTZ;  -- 처음 명단 줄에 연결된 때(7일 정리 대상 가름)
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS dormant_at      TIMESTAMPTZ;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS dormant_reason  TEXT;
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_dormant_reason_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_dormant_reason_check CHECK (dormant_reason IN ('retired','removed','left'));

-- 기존 연결 줄이 있는 계정은 「한 번은 연결된 적 있음」으로 채운다(7일 정리에 안 걸리게 · 이미 찬 칸은 안 건드림)
UPDATE app_user u SET first_linked_at = COALESCE(
    (SELECT min(COALESCE(m.linked_at, m.created_at)) FROM membership m WHERE m.user_id = u.id), u.created_at)
  WHERE u.first_linked_at IS NULL AND EXISTS (SELECT 1 FROM membership m WHERE m.user_id = u.id);

-- ── 초대 코드 ────────────────────────────────────────
-- 줄마다 살아 있는 코드는 하나(재발급하면 옛 코드 revoked_at · 그 줄에 계정이 연결돼도 revoked_at)
CREATE TABLE IF NOT EXISTS invite_code (
  id            BIGSERIAL PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES org(id),
  membership_id BIGINT NOT NULL REFERENCES membership(id),
  kind          TEXT NOT NULL CHECK (kind IN ('move_in','concurrent')),
  code          TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  used_at       TIMESTAMPTZ,
  used_by       BIGINT REFERENCES app_user(id),
  revoked_at    TIMESTAMPTZ,
  created_by    BIGINT REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS invite_code_code_uq ON invite_code (code);
CREATE UNIQUE INDEX IF NOT EXISTS invite_code_live_uq ON invite_code (membership_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- ── 연결 안 된 계정(승인 대기 · 연결 해제) ──────────────
CREATE TABLE IF NOT EXISTS unlinked_account (
  id            BIGSERIAL PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES org(id),
  user_id       BIGINT NOT NULL REFERENCES app_user(id),
  reason        TEXT NOT NULL CHECK (reason IN ('pending_approval','unlinked')),
  membership_id BIGINT REFERENCES membership(id),       -- 코드가 가리킨 줄 · 연결 해제면 떼어 낸 줄
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL                    -- 승인 대기 7일 · 연결 해제 30일
);
CREATE INDEX IF NOT EXISTS unlinked_account_open_idx ON unlinked_account (org_id, reason) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS unlinked_account_user_idx ON unlinked_account (user_id) WHERE resolved_at IS NULL;

-- ── 전출 요청 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfer_request (
  id               BIGSERIAL PRIMARY KEY,
  from_org         BIGINT NOT NULL REFERENCES org(id),
  to_org           BIGINT NOT NULL REFERENCES org(id),
  user_id          BIGINT NOT NULL REFERENCES app_user(id),
  to_membership_id BIGINT REFERENCES membership(id),
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','approved','rejected','expired')),
  created_by       BIGINT REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ,
  decided_by       BIGINT REFERENCES app_user(id),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX IF NOT EXISTS transfer_request_waiting_idx ON transfer_request (from_org) WHERE status = 'waiting';

-- ── 알림(소식) + 사람별 읽음 ─────────────────────────
-- 받는 쪽(audience): org_admins = 그 학교 기관 관리자 전원(org_id) · user = 당사자(user_id) · sysadmin = 총괄관리자
CREATE TABLE IF NOT EXISTS notification (
  id         BIGSERIAL PRIMARY KEY,
  audience   TEXT NOT NULL CHECK (audience IN ('org_admins','user','sysadmin')),
  org_id     BIGINT REFERENCES org(id),
  user_id    BIGINT REFERENCES app_user(id),
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  link       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((audience = 'org_admins' AND org_id IS NOT NULL) OR (audience = 'user' AND user_id IS NOT NULL) OR audience = 'sysadmin')
);
CREATE INDEX IF NOT EXISTS notification_org_idx ON notification (org_id, created_at DESC) WHERE audience = 'org_admins';
CREATE INDEX IF NOT EXISTS notification_user_idx ON notification (user_id, created_at DESC) WHERE audience = 'user';
CREATE TABLE IF NOT EXISTS notification_read (
  notification_id BIGINT NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES app_user(id),
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

-- ── 도움·요청 ────────────────────────────────────────
-- 글쓴이(author_user_id)는 화면에 안 낸다. stage = 처리 상태(column 은 예약어라 못 씀)
CREATE TABLE IF NOT EXISTS board_post (
  id             BIGSERIAL PRIMARY KEY,
  org_id         BIGINT REFERENCES org(id),
  author_user_id BIGINT REFERENCES app_user(id),
  kind           TEXT NOT NULL CHECK (kind IN ('bug','usability','feature','question')),
  visibility     TEXT NOT NULL CHECK (visibility IN ('org_admins','sysadmin','org_and_sysadmin','public')),
  stage          TEXT NOT NULL DEFAULT 'received' CHECK (stage IN ('received','reviewing','working','done','hold')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  tags           TEXT[] NOT NULL DEFAULT '{}',
  group_id       BIGINT REFERENCES board_post(id),
  context        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS board_post_org_idx ON board_post (org_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS board_comment (
  id             BIGSERIAL PRIMARY KEY,
  post_id        BIGINT NOT NULL REFERENCES board_post(id),
  author_user_id BIGINT REFERENCES app_user(id),
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS board_comment_post_idx ON board_comment (post_id, created_at);
-- 첨부는 DB 안 압축 저장 · 건당 10MB · 90일 뒤 비움
CREATE TABLE IF NOT EXISTS board_attachment (
  id          BIGSERIAL PRIMARY KEY,
  post_id     BIGINT NOT NULL REFERENCES board_post(id),
  file_name   TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 0 AND size <= 10485760),
  bytes       BYTEA,                                   -- 압축 · 비우면 NULL
  purge_after TIMESTAMPTZ NOT NULL DEFAULT now() + interval '90 days',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS board_attachment_post_idx ON board_attachment (post_id);

-- ── 오류 기록(자동 수집 · 입력값·이름은 서버가 가린 뒤 싣는다) ──
CREATE TABLE IF NOT EXISTS error_report (
  id            BIGSERIAL PRIMARY KEY,
  org_id        BIGINT REFERENCES org(id),
  user_id       BIGINT REFERENCES app_user(id),
  message       TEXT NOT NULL,
  stack         TEXT,
  screen        TEXT,
  version       TEXT,
  ua            TEXT,
  recent        JSONB NOT NULL DEFAULT '[]'::jsonb,
  board_post_id BIGINT REFERENCES board_post(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_report_created_idx ON error_report (created_at DESC);

-- ── 가입 시도(같은 IP 횟수 제한 · IP 는 해시만) ──────────
CREATE TABLE IF NOT EXISTS signup_attempt (
  id      BIGSERIAL PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_attempt_ip_idx ON signup_attempt (ip_hash, at DESC);
