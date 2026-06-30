// 极简 markdown → 终端样式渲染（够覆盖模型常回的语法）。
// 一行 = 若干带样式的 span；交给 Ink 的 <Text bold/italic/color> 渲染。
// 与滚动用的「行级窗口」天然兼容（仍是一行一行的）。

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  dim?: boolean;
}
export type Line = Span[];

/** 估算显示宽度：CJK/全角/emoji 记 2 列，其余 1 列（用于按终端宽度折行）。 */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

const sameStyle = (a: Span, b: Span) =>
  !!a.bold === !!b.bold &&
  !!a.italic === !!b.italic &&
  a.color === b.color &&
  !!a.dim === !!b.dim;

/** 把一串 span 按显示宽度折行（逐字符，CJK 友好），样式随之保留。 */
export function wrapSpans(spans: Span[], width: number): Line[] {
  const lines: Line[] = [];
  let cur: Line = [];
  let curW = 0;
  for (const sp of spans) {
    for (const ch of sp.text) {
      const w = dispWidth(ch);
      if (curW + w > width && curW > 0) {
        lines.push(cur);
        cur = [];
        curW = 0;
      }
      const last = cur[cur.length - 1];
      if (last && sameStyle(last, sp)) last.text += ch;
      else cur.push({ ...sp, text: ch });
      curW += w;
    }
  }
  lines.push(cur); // 末行（可能空）
  return lines;
}

/** 行内解析：**粗体**、`代码`、*斜体* / _斜体_ → spans（不折行）。 */
export function parseInline(text: string, base: Partial<Span> = {}): Span[] {
  const spans: Span[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) spans.push({ ...base, text: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ ...base, text: m[1], bold: true });
    else if (m[2] !== undefined) spans.push({ ...base, text: m[2], color: "cyan" }); // 行内代码
    else if (m[3] !== undefined) spans.push({ ...base, text: m[3], italic: true });
    else if (m[4] !== undefined) spans.push({ ...base, text: m[4], italic: true });
    last = re.lastIndex;
  }
  if (last < text.length) spans.push({ ...base, text: text.slice(last) });
  return spans.length ? spans : [{ ...base, text }];
}

/** 普通文本（非 markdown）：按宽折行，整体套一个基础样式。 */
export function plainToLines(
  text: string,
  width: number,
  base: Partial<Span> = {}
): Line[] {
  return wrapSpans([{ ...base, text }], width);
}

/** markdown → 折好行的 Line[]：标题/列表/引用/代码块 + 行内粗体/代码/斜体。 */
export function mdToLines(text: string, width: number): Line[] {
  const out: Line[] = [];
  let inCode = false;
  for (const raw of text.split("\n")) {
    // 代码围栏 ``` 切换
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      out.push([{ text: inCode ? "┄┄┄ code ┄┄┄" : "┄┄┄┄┄┄┄┄┄┄", dim: true }]);
      continue;
    }
    if (inCode) {
      out.push(...wrapSpans([{ text: raw, color: "green" }], width));
      continue;
    }
    // 标题 # ~ ######
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      out.push(...wrapSpans([{ text: h[2]!, bold: true, color: "cyanBright" }], width));
      continue;
    }
    // 引用 >
    const q = /^>\s?(.*)$/.exec(raw);
    if (q) {
      out.push(
        ...wrapSpans([{ text: "│ ", dim: true }, ...parseInline(q[1]!, { dim: true })], width)
      );
      continue;
    }
    // 无序列表 -, *, +
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (b) {
      out.push(...wrapSpans([{ text: `${b[1]}• ` }, ...parseInline(b[2]!)], width));
      continue;
    }
    // 有序列表 1.
    const n = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
    if (n) {
      out.push(
        ...wrapSpans([{ text: `${n[1]}${n[2]}. `, color: "yellow" }, ...parseInline(n[3]!)], width)
      );
      continue;
    }
    // 空行
    if (raw.trim() === "") {
      out.push([{ text: "" }]);
      continue;
    }
    // 普通行（表格 | a | b | 也走这里，等宽终端自然对齐）
    out.push(...wrapSpans(parseInline(raw), width));
  }
  return out;
}
