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

// ———————————————————— 表格 ————————————————————

/** 把一行表格按 | 切成单元格（去掉首尾竖线、各自 trim）。 */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** 是否是表格分隔行（每个单元格都是 :--- / --- / ---: 这种）。 */
function isSepRow(line: string): boolean {
  if (!line.includes("|") && !/-/.test(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/** 把一组单元格 span 用「 │ 」连起来成一行。 */
function joinCells(cells: Span[][]): Line {
  const line: Span[] = [];
  cells.forEach((spans, i) => {
    if (i > 0) line.push({ text: " │ ", dim: true });
    line.push(...spans);
  });
  return line;
}

/** 渲染对齐的表格：表头加粗、分隔线、各列按内容宽度补齐。 */
function renderTable(header: string[], rows: string[][]): Line[] {
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1);
  const norm = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? "");
  const H = norm(header);
  const R = rows.map(norm);
  const colW = Array.from({ length: cols }, (_, i) =>
    Math.max(dispWidth(H[i]!), ...R.map((r) => dispWidth(r[i]!)), 1)
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - dispWidth(s)));
  const out: Line[] = [];
  // 表头（加粗）
  out.push(joinCells(H.map((c, i) => parseInline(pad(c, colW[i]!), { bold: true }))));
  // 分隔线（与「 │ 」对齐用「─┼─」）
  out.push([{ text: colW.map((w) => "─".repeat(w)).join("─┼─"), dim: true }]);
  // 数据行
  for (const r of R) out.push(joinCells(r.map((c, i) => parseInline(pad(c, colW[i]!)))));
  return out;
}

/** markdown → 折好行的 Line[]：标题/列表/引用/代码块/表格/分隔线 + 行内粗体/代码/斜体。 */
export function mdToLines(text: string, width: number): Line[] {
  const out: Line[] = [];
  const lines = text.split("\n");
  let inCode = false;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;

    // 代码围栏 ``` 切换
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      out.push([{ text: inCode ? "┄┄┄ code ┄┄┄" : "┄┄┄┄┄┄┄┄┄┄", dim: true }]);
      i++;
      continue;
    }
    if (inCode) {
      out.push(...wrapSpans([{ text: raw, color: "green" }], width));
      i++;
      continue;
    }

    // 水平线 --- / *** / ___（3+ 个，整行）
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      out.push([{ text: "─".repeat(Math.min(width, 48)), dim: true }]);
      i++;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行 → 吃掉整个表格块
    if (raw.includes("|") && i + 1 < lines.length && isSepRow(lines[i + 1]!)) {
      const header = splitRow(raw);
      i += 2; // 跳过表头 + 分隔行
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i]!.includes("|") &&
        lines[i]!.trim() !== "" &&
        !isSepRow(lines[i]!)
      ) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      out.push(...renderTable(header, rows));
      continue;
    }

    // 标题 # ~ ######
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      out.push(...wrapSpans([{ text: h[2]!, bold: true, color: "cyanBright" }], width));
      i++;
      continue;
    }
    // 引用 >
    const q = /^>\s?(.*)$/.exec(raw);
    if (q) {
      out.push(
        ...wrapSpans([{ text: "│ ", dim: true }, ...parseInline(q[1]!, { dim: true })], width)
      );
      i++;
      continue;
    }
    // 无序列表 -, *, +
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (b) {
      out.push(...wrapSpans([{ text: `${b[1]}• ` }, ...parseInline(b[2]!)], width));
      i++;
      continue;
    }
    // 有序列表 1.
    const n = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
    if (n) {
      out.push(
        ...wrapSpans([{ text: `${n[1]}${n[2]}. `, color: "yellow" }, ...parseInline(n[3]!)], width)
      );
      i++;
      continue;
    }
    // 空行
    if (raw.trim() === "") {
      out.push([{ text: "" }]);
      i++;
      continue;
    }
    // 普通行
    out.push(...wrapSpans(parseInline(raw), width));
    i++;
  }
  return out;
}
