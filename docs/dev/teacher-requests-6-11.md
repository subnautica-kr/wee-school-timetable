# 교사 요청 6~11번 — 지금 상태와 고칠 자리

> 만든 판: T-1201(준비 판). 지금 동작은 `test/teacher-requests-repro.test.js` 가 굳혀 둔다 — 고치는 판은 그 시험의 기대값을 뒤집는다.
> 옛 요청 파일 이름은 옮겨졌다: `s1c/Grid.jsx` → `web/src/grid/Grid.jsx`, `s4b/Output.jsx` → `web/src/export/Output.jsx`. 학교 화면은 `web/src/school/SchoolPage.jsx`.

| 번호 | 한 줄 | 맡을 판 |
|---|---|---|
| 6 | 한 칸에 교사 둘 | T-1206 |
| 7 | 빠진 교사 알림이 사람마다 하나 | T-1203 반영 |
| 8 | 점심 시각만 넣으면 점심 자리가 0 | T-1202 반영 |
| 9 | 하교 판정·빈칸 수가 요일을 모름 | T-1205 |
| 10 | 시수표 한꺼번에 올리기 없음 | T-1204 |
| 11 | 원문이 가리킨 코드 없음 | T-1208 |

## 6번 — 한 칸에 교사 둘 (T-1206)
- 원문이 가리킨 곳 → `web/src/grid/Grid.jsx:157·169·325`(칸 편집 폼: 교사 하나만 고름) · `server/routes/timetables.js:74`(교사별 시간표가 `c.membership_id = $3` 하나로 묻는다) · `shared/overlap.js:85`(`scan('membership_id', 'teacher_overlap', …)`) · `server/candidates.js:23`(`teaching` 집합이 칸의 `membership_id` 하나만 모은다)
- 지금 상태 → `teaching_load`·`cell` 테이블에 교사 열은 `membership_id` 하나뿐(시험이 `information_schema` 로 확인). 둘째 교사를 담을 곳이 없다.
- 고칠 자리 → 열 추가(또는 칸-교사 연결 표) + 위 네 곳이 둘째 교사도 읽게. 겹침 검사·보결 후보의 「수업 중」 집합도 같이.

## 7번 — 빠진 교사 알림 (T-1203)
- 원문이 가리킨 곳 → `web/src/school/SchoolPage.jsx:172·241` · `server/routes/export.js:115-129`(담임 교과 일괄 적용) · `web/src/gen/core.js:44`(`applySmall` 담임 교과 채움)
- 지금 상태 → `GET /loads` 의 `alerts` 가 시수 줄 없는 교사마다 하나(`missingTeachers`, loads.js:47). 큰 학교를 담임 시수 없이 심으면 51(담임)+5(비교과)=56건이 화면에 줄줄이 뜬다(시험: 56).
- 고칠 자리 → 한 줄로 묶어 「N명 빠짐」 + 펼치기. 담임은 담임 교과 일괄 적용을 안내하고, 비교과는 시수표가 없어도 되는 경우 제외.

## 8번 — 점심 자리 (T-1202)
- 원문이 가리킨 곳 → `web/src/school/SchoolPage.jsx:163·186`(화면은 점심 「시각」만 받는다) · `web/src/gen/core.js:27·88`
- 지금 상태 → `prepare` 가 `L: g.lunchAfter || 0` 로만 읽는다. 화면으로 넣은 자료는 `lunch: '12:00'` 만 있고 `lunchAfter` 가 없어 `classes[0].L` 이 0(시험). 같은 이유로 보결 후보의 급식지도 경고(`candidates.js:42-44`)도 `lunch` 와 `lunchAfter` 둘 다 있어야만 뜬다 — `lunchAfter` 만 있어도, `lunch` 만 있어도 경고 없음(시험 (나)).
- 고칠 자리 → 점심 시각과 교시 시각표로 「몇 교시 뒤」를 계산해 `L` 을 채우거나, 화면이 `lunchAfter` 도 받게. 판정 조건을 한쪽만 있어도 되게.

## 9번 — 요일별 하교 (T-1205)
- 원문이 가리킨 곳 → `server/candidates.js:48` · `shared/ttConfirm.js:2` · `web/src/gen/core.js:88·233` · `web/src/school/SchoolPage.jsx:283` · 고정·금지 `server/routes/pins.js`
- 지금 상태 → 하교 판정 `period > g.periods` 는 요일을 안 본다(수요일에도 월요일과 같은 판정, 시험). `emptyCount` 는 `학년 교시 수 × 5` 고정이라 요일마다 교시가 다른 학교의 빈칸 수가 틀린다(시험: 1학년 5교시 → 25). 생성기도 학년당 `P` 하나.
- 고칠 자리 → 학년 설정에 요일별 교시 수를 두고(`periods` 를 요일 배열로) 세 곳이 같은 함수를 읽게. 요일별 하교 시각은 고정·금지(pins)로 흉내 낼 수는 있다 — 그러나 보결·빈칸 수는 못 맞춘다.

## 10번 — 시수표 올리기 (T-1204)
- 원문이 가리킨 곳 → `web/src/school/SchoolPage.jsx:233-262`(시수표 화면: 줄 하나씩 「줄 추가」) · `server/routes/loads.js:35·107`
- 지금 상태 → 라우트는 `GET /loads`·`GET /loads/effective`·`POST /loads`·`PATCH`·`DELETE` 뿐. 올리기·붙여넣기·일괄 라우트 없음(시험이 라우트 목록을 못박음). 큰 학교 시수표 102줄을 손으로 넣어야 한다.
- 고칠 자리 → `POST /loads/import`(줄 배열 + 미리보기) + 화면 붙여넣기 칸. 교사·반·교과 이름을 id 로 찾는 규칙과 못 찾은 줄 보고가 핵심.

## 11번 (T-1208)
- 원문이 가리킨 곳 → 없음. 지금 코드에서 이 번호에 해당하는 파일·줄을 못 찾았다.
- 지금 상태 → 재현 안 됨(가리킬 곳이 없다).
- 고칠 자리 → 판 T-1208 이 원문을 다시 읽고 정한다.

## 옛 요청 4·5번 — 이미 있음
- ④ 고정·금지 화면 있음 → `web/src/school/SchoolPage.jsx:273-305`(화면) · 탭 `:345·351` · `server/routes/pins.js`
- ⑤ 빠진 교사 알림 있음 → `server/rules.js:13`(규칙 `load_missing_teacher`) · `server/routes/loads.js:47` · `web/src/school/SchoolPage.jsx:241`. 덜 채운 줄 표시 있음 → `loads.js:32`(`isIncomplete`) · `SchoolPage.jsx:244·265`(노랑 줄·안내 문구).
