import { Fragment } from 'react';
import { t } from '../../shared/text/index.js';
import Term from './Term.jsx';

export { t };

// 문구 하나를 그린다 — <T k="roster.link.title" v={{ 이름: m.name }} />
// 문구 안 꾸밈: [[낱말]] → 낱말 풀이(<Term>) · **굵게** → <b> · 줄 바꿈(\n) → <br />. 글자만 필요하면 t() 를 쓴다.
const MARK = /\[\[([^\]]+)\]\]|\*\*([^*]+)\*\*|\n/g;

export function renderText(s) {
  const out = [];
  let last = 0, i = 0;
  for (const m of s.matchAll(MARK)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1] !== undefined) out.push(<Term key={i++} k={m[1]}>{m[1]}</Term>);
    else if (m[2] !== undefined) out.push(<b key={i++}>{m[2]}</b>);
    else out.push(<br key={i++} />);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export default function T({ k, v }) {
  return <Fragment>{renderText(t.raw(k, v))}</Fragment>;
}
