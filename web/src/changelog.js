// CHANGELOG.md(Keep a Changelog 꼴) → [{ version, date, groups: [{ title, items: [string] }] }]. 순수 함수.
// [Unreleased] 와 머리 문단은 버리고 `## [x.y.z] - 날짜` 칸만 남긴다. 줄 안의 마크다운은 그대로 둔다(그리기는 화면 몫).
export function parseChangelog(text) {
  const out = [];
  let ver = null;
  let grp = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h2 = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line);
    if (h2) {
      grp = null;
      if (/^unreleased$/i.test(h2[1])) { ver = null; continue; }
      ver = { version: h2[1], date: h2[2] || '', groups: [] };
      out.push(ver);
      continue;
    }
    if (!ver) continue;
    const h3 = /^###\s+(.+)/.exec(line);
    if (h3) { grp = { title: h3[1].trim(), items: [] }; ver.groups.push(grp); continue; }
    const li = /^[-*]\s+(.+)/.exec(line);
    if (li) {
      if (!grp) { grp = { title: '', items: [] }; ver.groups.push(grp); }
      grp.items.push(li[1]);
    }
  }
  return out;
}

// `**굵게**`·`` `코드` `` 만 잘라 [{ t: 'text'|'b'|'code', s }] 로. HTML 을 만들지 않는다.
export function splitInline(s) {
  const parts = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push({ t: 'text', s: s.slice(last, m.index) });
    parts.push(m[1] !== undefined ? { t: 'b', s: m[1] } : { t: 'code', s: m[2] });
    last = re.lastIndex;
  }
  if (last < s.length) parts.push({ t: 'text', s: s.slice(last) });
  return parts;
}

// 「새 기능이 있어요」 표시 판정 — 본 마지막 버전(seen)이 지금 버전과 같으면 false, 다르거나 없으면 true.
export function hasNewVersion(seen, current) {
  return !seen || seen !== current;
}
