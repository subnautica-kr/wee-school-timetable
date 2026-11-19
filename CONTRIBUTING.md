# 기여 안내

관심 가져 주셔서 고맙습니다. 작은 고침부터 큰 기능까지 환영합니다.

## 시작하기

1. **이슈 먼저** — 큰 변경은 코드를 쓰기 전에 이슈로 방향을 맞춰 주세요. 작은 오타·버그 수정은 바로 PR 도 좋습니다.
2. 개발 환경(DB·실행 방법)은 [docs/development.md](docs/development.md)를 보세요.
3. 질문은 이슈 대신 Discussions 에 남겨 주세요.

## 가지와 커밋

- 저장소를 포크한 뒤 `main` 에서 주제별 가지를 땁니다(예: `fix/export-font`, `feat/room-booking`).
- 커밋 하나는 변경 하나. 메시지는 짧은 한 줄 요약(한국어 가능)으로 무엇이 바뀌었는지 적습니다.

## PR 전에

```
npm test            # PostgreSQL 이 필요합니다(DATABASE_URL)
npm run build:web   # 화면이 빌드되는지 확인
```

- 시험 자료·예시·스크린샷에는 **지어낸 이름만** 씁니다. 실제 학교·교사·학생 자료는 넣지 마세요.
- 화면 문구는 한국어입니다.
- 권한·보안에 닿는 변경은 시험을 함께 추가해 주세요.

## 라이선스

기여한 내용은 이 저장소와 같은 [MIT 라이선스](LICENSE)로 배포되는 데 동의한 것으로 봅니다.
행동 수칙은 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), 보안 문제는 [SECURITY.md](SECURITY.md)를 따릅니다.
