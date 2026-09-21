// 本地墙钟时间 -> UTC instant 的核心解析逻辑。
// 纯函数、不依赖 express，服务端与测试共用；前端不做任何时区算术。

export type DisambiguationPolicy = 'compatible' | 'earlier' | 'later' | 'reject';
export const POLICIES: DisambiguationPolicy[] = ['compatible', 'earlier', 'later', 'reject'];

export type DiagnosticLevel = 'error' | 'warning';
export type Diagnostic = {line: number; level: DiagnosticLevel; code: string; message: string};

export type Transition = {atUtc: number; offsetSeconds: number};
export type Zone = {
  name: string;
  baseOffsetSeconds: number;
  transitions: Transition[]; // 已按 atUtc 升序排列
};

export type BundleDoc = {zones: Zone[]; diagnostics: Diagnostic[]};

// ---------- 墙钟 / instant 的确定性换算（不经过 Date，避免宿主时区影响） ----------

const SECONDS_PER_DAY = 86400;

// Howard Hinnant 的 civil date 算法，返回 1970-01-01 以来的天数
function daysFromCivil(y: number, m: number, d: number): number {
  const y2 = y - (m <= 2 ? 1 : 0);
  const era = y2 >= 0 ? Math.floor(y2 / 400) : Math.floor((y2 - 399) / 400);
  const yoe = y2 - era * 400;
  const doy = (((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) | 0) + d - 1;
  const doe = yoe * 365 + ((yoe / 4) | 0) - ((yoe / 100) | 0) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): {y: number; m: number; d: number} {
  const zz = z + 719468;
  const era = zz >= 0 ? Math.floor(zz / 146097) : Math.floor((zz - 146096) / 146097);
  const doe = zz - era * 146097;
  const yoe = (((doe - ((doe / 1460) | 0) + ((doe / 36524) | 0) - ((doe / 146096) | 0)) / 365) | 0);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + ((yoe / 4) | 0) - ((yoe / 100) | 0));
  const mp = (((5 * doy + 2) / 153) | 0);
  const d = doy - (((153 * mp + 2) / 5) | 0) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return {y: y + (m <= 2 ? 1 : 0), m, d};
}

export type WallParts = {y: number; mo: number; d: number; h: number; mi: number; s: number; frac: number};

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?Z$/;

function parseWith(re: RegExp, text: string): WallParts | null {
  const m = re.exec(text);
  if (!m) return null;
  const frac = m[7] ? Number(`0.${m[7]}`) : 0;
  return {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: Number(m[4]), mi: Number(m[5]), s: m[6] ? Number(m[6]) : 0, frac,
  };
}

function validateParts(p: WallParts): boolean {
  if (p.mo < 1 || p.mo > 12 || p.d < 1 || p.d > 31) return false;
  if (p.h > 23 || p.mi > 59 || p.s > 59) return false; // 不处理闰秒输入，保证往返严格成立
  const dim = [31, ((p.y % 4 === 0 && p.y % 100 !== 0) || p.y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return p.d <= dim[p.mo - 1];
}

function partsToDaySeconds(p: WallParts): number {
  return daysFromCivil(p.y, p.mo, p.d) * SECONDS_PER_DAY + p.h * 3600 + p.mi * 60 + p.s + p.frac;
}

/** 解析无时区后缀的本地墙钟时间，返回带小数秒的 epoch 秒；失败抛错。 */
export function parseWall(text: string): number {
  const p = parseWith(WALL_RE, text);
  if (!p || !validateParts(p)) throw new Error(`invalid_local:${text}`);
  return partsToDaySeconds(p);
}

/** 解析 UTC 瞬间（要求 Z 后缀）。 */
export function parseUtc(text: string): number {
  const p = parseWith(UTC_RE, text);
  if (!p || !validateParts(p)) throw new Error(`invalid_utc:${text}`);
  return partsToDaySeconds(p);
}

function pad2(n: number): string {return String(n).padStart(2, '0');}

/** epoch 秒（UTC，可带小数）格式化为 ISO，附加 Z。 */
export function formatInstant(total: number): string {
  const frac = total - Math.floor(total);
  const days = Math.floor(total / SECONDS_PER_DAY);
  const rest = Math.floor(total - days * SECONDS_PER_DAY);
  const {y, m, d} = civilFromDays(days);
  const hh = rest / 3600 | 0, mm = rest % 3600 / 60 | 0, ss = rest % 60;
  const fracText = frac > 0 ? '.' + String(frac).slice(2, 5).padEnd(3, '0') : '';
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${fracText}Z`;
}

/** epoch 秒解释为某偏移下的墙钟文本（无后缀）。 */
export function formatWall(total: number): string {
  const frac = total - Math.floor(total);
  const days = Math.floor(total / SECONDS_PER_DAY);
  const rest = Math.floor(total - days * SECONDS_PER_DAY);
  const {y, m, d} = civilFromDays(days);
  const hh = rest / 3600 | 0, mm = rest % 3600 / 60 | 0, ss = rest % 60;
  const fracText = frac > 0 ? '.' + String(frac).slice(2, 5).padEnd(3, '0') : '';
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${fracText}`;
}

// ---------- 偏移量 ----------

const OFFSET_RE = /^([+-])(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?$/;

export function parseOffset(token: string): number {
  if (token === 'Z' || token === 'z') return 0;
  const m = OFFSET_RE.exec(token);
  if (!m) throw new Error(`invalid_offset:${token}`);
  const h = Number(m[2]), mi = m[3] ? Number(m[3]) : 0, s = m[4] ? Number(m[4]) : 0;
  if (h > 23 || mi > 59 || s > 59) throw new Error(`invalid_offset:${token}`);
  const total = h * 3600 + mi * 60 + s;
  return m[1] === '-' ? -total : total;
}

export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(seconds);
  const h = abs / 3600 | 0, mi = abs % 3600 / 60 | 0, s = abs % 60;
  const base = `${sign}${pad2(h)}:${pad2(mi)}`;
  return s ? `${base}:${pad2(s)}` : base;
}

export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  const h = abs / 3600 | 0, mi = abs % 3600 / 60 | 0, s = abs % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} 小时`);
  if (mi) parts.push(`${mi} 分钟`);
  if (s || parts.length === 0) parts.push(`${s} 秒`);
  return parts.join('');
}

// ---------- bundle 文本解析 ----------
//
// 行格式（# 开头为注释）：
//   zone <名称> <基础偏移，如 +08:00 / -01:00 / Z>
//   at   <UTC ISO，如 2024-03-10T07:00:00Z> <过渡后的偏移>

export function parseBundle(content: string): BundleDoc {
  const diagnostics: Diagnostic[] = [];
  const zones: Zone[] = [];
  let current: Zone | null = null;
  const seen = new Set<string>();

  content.split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1;
    const text = raw.trim();
    if (!text || text.startsWith('#')) return;
    const parts = text.split(/\s+/);
    if (parts[0] === 'zone') {
      const [, name, offsetToken] = parts;
      if (!name || !offsetToken) {
        diagnostics.push({line, level: 'error', code: 'bad_zone_line', message: `zone 行需要“名称 + 基础偏移”：${raw}`});
        return;
      }
      let offset: number;
      try {offset = parseOffset(offsetToken);}
      catch {diagnostics.push({line, level: 'error', code: 'bad_offset', message: `无法识别的偏移 ${offsetToken}`}); return;}
      if (seen.has(name)) {diagnostics.push({line, level: 'error', code: 'duplicate_zone', message: `zone ${name} 重复定义`}); return;}
      seen.add(name);
      current = {name, baseOffsetSeconds: offset, transitions: []};
      zones.push(current);
      return;
    }
    if (parts[0] === 'at') {
      if (!current) {diagnostics.push({line, level: 'error', code: 'orphan_at', message: `at 行前面没有 zone：${raw}`}); return;}
      const [, whenToken, offsetToken] = parts;
      if (!whenToken || !offsetToken) {diagnostics.push({line, level: 'error', code: 'bad_at_line', message: `at 行需要“UTC 瞬间 + 新偏移”：${raw}`}); return;}
      let atUtc: number, offset: number;
      try {atUtc = parseUtc(whenToken);}
      catch {diagnostics.push({line, level: 'error', code: 'bad_utc', message: `无法识别的 UTC 瞬间 ${whenToken}`}); return;}
      try {offset = parseOffset(offsetToken);}
      catch {diagnostics.push({line, level: 'error', code: 'bad_offset', message: `无法识别的偏移 ${offsetToken}`}); return;}
      if (current.transitions.some(tr => tr.atUtc === atUtc)) {
        diagnostics.push({line, level: 'error', code: 'duplicate_transition', message: `${current.name} 在 ${whenToken} 有重复过渡`});
        return;
      }
      const last = current.transitions[current.transitions.length - 1];
      if (last && atUtc < last.atUtc) {
        diagnostics.push({line, level: 'warning', code: 'transition_out_of_order', message: `${current.name} 的过渡未按时间排列，已自动排序`});
      }
      current.transitions.push({atUtc, offsetSeconds: offset});
      return;
    }
    diagnostics.push({line, level: 'error', code: 'unparsable_line', message: `无法解析：${raw}`});
  });

  for (const z of zones) z.transitions.sort((a, b) => a.atUtc - b.atUtc);
  return {zones, diagnostics};
}

export function hasErrors(doc: BundleDoc): boolean {
  return doc.diagnostics.some(d => d.level === 'error');
}

// ---------- 本地时间 -> 候选 instant ----------

export type CandidateSide = 'before' | 'after' | 'between';
export type Occurrence = 'only' | 'first' | 'second' | 'extra';

export type Candidate = {
  instant: string;
  epochSeconds: number;
  offsetSeconds: number;
  offsetLabel: string;
  side: CandidateSide;
  occurrence: Occurrence;
  ordinal: number; // 在全部候选中按 instant 升序的序号（1 起）
  exists: boolean; // false = gap 中的插值，该墙钟时间实际不存在
  wallShiftSeconds: number; // gap：相对正常时间线的前拨(+)/回拨(-)；unique/overlap 为 0
  basis: string;
};

export type GapBoundary = {
  local: string;
  instant: string; // 该边界墙钟对应的真实 UTC 瞬间
  epochSeconds: number;
  offsetSeconds: number;
  offsetLabel: string;
  real: boolean;
};

export type TransitionInfo = {
  instant: string;
  atUtc: number;
  offsetBeforeSeconds: number;
  offsetBeforeLabel: string;
  offsetAfterSeconds: number;
  offsetAfterLabel: string;
};

export type ResolveKind = 'unique' | 'gap' | 'overlap';

export type ResolvedChoice = {
  instant: string;
  epochSeconds: number;
  offsetSeconds: number;
  offsetLabel: string;
  side: CandidateSide;
  note: string;
  roundTripLocal: string;
  roundTripOk: boolean;
};

export type ResolveResult = {
  kind: ResolveKind;
  zone: string;
  local: string;
  epochSecondsInput: number;
  policy: DisambiguationPolicy;
  candidates: Candidate[]; // 一律按 instant 升序
  gap?: {shiftSeconds: number; before: GapBoundary; after: GapBoundary};
  transition: TransitionInfo | null;
  resolved: ResolvedChoice | null; // reject 且非 unique 时为 null
};

type Segment = {
  index: number;
  lo: number; // -Infinity
  hi: number; // +Infinity
  offset: number;
};

function buildSegments(zone: Zone): Segment[] {
  const n = zone.transitions.length;
  const offsets = [zone.baseOffsetSeconds, ...zone.transitions.map(t => t.offsetSeconds)];
  const segs: Segment[] = [];
  for (let i = 0; i <= n; i++) {
    const lo = i === 0 ? -Infinity : zone.transitions[i - 1].atUtc + offsets[i];
    const hi = i === n ? Infinity : zone.transitions[i].atUtc + offsets[i];
    segs.push({index: i, lo, hi, offset: offsets[i]});
  }
  return segs;
}

function transitionInfo(zone: Zone, transitionIndex: number): TransitionInfo {
  const tr = zone.transitions[transitionIndex];
  const beforeOffset = transitionIndex === 0 ? zone.baseOffsetSeconds : zone.transitions[transitionIndex - 1].offsetSeconds;
  return {
    instant: formatInstant(tr.atUtc),
    atUtc: tr.atUtc,
    offsetBeforeSeconds: beforeOffset,
    offsetBeforeLabel: formatOffset(beforeOffset),
    offsetAfterSeconds: tr.offsetSeconds,
    offsetAfterLabel: formatOffset(tr.offsetSeconds),
  };
}

function sideFor(segmentIndex: number, matched: number[], transitionCount: number): CandidateSide {
  if (segmentIndex === matched[0] && segmentIndex === matched[matched.length - 1]) {
    // 唯一匹配：相对最近过渡描述
    return segmentIndex < transitionCount ? 'before' : 'after';
  }
  if (segmentIndex === matched[0]) return 'before';
  if (segmentIndex === matched[matched.length - 1]) return 'after';
  return 'between';
}

function occurrenceFor(ordinal: number, total: number): Occurrence {
  if (total === 1) return 'only';
  if (ordinal === 1) return 'first';
  if (ordinal === 2 && total === 2) return 'second';
  return 'extra';
}

export class ResolveError extends Error {}

export function resolveLocal(zone: Zone, localText: string, policy: DisambiguationPolicy): ResolveResult {
  let wall: number;
  try {
    wall = parseWall(localText);
  } catch {
    throw new ResolveError(`无法解析本地时间：${localText}（需要 YYYY-MM-DDTHH:MM:SS）`);
  }

  const segments = buildSegments(zone);
  const matched = segments
    .filter(seg => wall >= seg.lo && wall < seg.hi)
    .map(seg => seg.index);

  const base: Omit<ResolveResult, 'kind' | 'candidates' | 'gap' | 'transition' | 'resolved'> = {
    zone: zone.name,
    local: formatWall(wall),
    epochSecondsInput: wall,
    policy,
  };

  // ---- unique ----
  if (matched.length === 1) {
    const seg = segments[matched[0]];
    const epoch = wall - seg.offset;
    const side: CandidateSide = seg.index < zone.transitions.length ? 'before' : 'after';
    const basis = `唯一映射：该墙钟时间仅出现一次，区域当时使用偏移 ${formatOffset(seg.offset)}。`;
    const candidate: Candidate = {
      instant: formatInstant(epoch), epochSeconds: epoch,
      offsetSeconds: seg.offset, offsetLabel: formatOffset(seg.offset),
      side, occurrence: 'only', ordinal: 1, exists: true, wallShiftSeconds: 0, basis,
    };
    const roundTripLocal = formatWall(epoch + seg.offset);
    return {
      ...base, kind: 'unique', candidates: [candidate], transition: null,
      resolved: {
        instant: candidate.instant, epochSeconds: epoch,
        offsetSeconds: seg.offset, offsetLabel: candidate.offsetLabel, side,
        note: `唯一候选，无需消歧；策略 ${policy} 直接采用偏移 ${candidate.offsetLabel}。`,
        roundTripLocal, roundTripOk: roundTripLocal === base.local,
      },
    };
  }

  // ---- gap：没有任何偏移段能产生该墙钟时间 ----
  if (matched.length === 0) {
    let k = -1;
    for (let i = 0; i < zone.transitions.length; i++) {
      const tr = zone.transitions[i];
      const oldOffset = i === 0 ? zone.baseOffsetSeconds : zone.transitions[i - 1].offsetSeconds;
      const a = tr.atUtc + oldOffset;
      const b = tr.atUtc + tr.offsetSeconds;
      if (wall >= Math.min(a, b) && wall < Math.max(a, b)) {k = i; break;}
    }
    if (k < 0) throw new ResolveError(`${zone.name} 的数据无法覆盖本地时间 ${base.local}（可能存在连续异常过渡）`);
    const tr = zone.transitions[k];
    const oldOffset = k === 0 ? zone.baseOffsetSeconds : zone.transitions[k - 1].offsetSeconds;
    const newOffset = tr.offsetSeconds;
    const delta = newOffset - oldOffset;
    const info = transitionInfo(zone, k);

    const before: GapBoundary = {
      local: formatWall(tr.atUtc + oldOffset), instant: formatInstant(tr.atUtc), epochSeconds: tr.atUtc,
      offsetSeconds: oldOffset, offsetLabel: formatOffset(oldOffset), real: true,
    };
    const after: GapBoundary = {
      local: formatWall(tr.atUtc + newOffset), instant: formatInstant(tr.atUtc), epochSeconds: tr.atUtc,
      offsetSeconds: newOffset, offsetLabel: formatOffset(newOffset), real: true,
    };

    // 两个插值候选：按过渡前 / 过渡后偏移分别解释，再按 instant 排序。
    // 前拨间隙 delta>0：用过渡后偏移解释得到的 instant 落在过渡之前（较早），
    // 用过渡前偏移解释得到的 instant 落在过渡之后（较晚），排序会自动处理。
    const raw: Array<{side: CandidateSide; offset: number; epoch: number}> = [
      {side: 'before' as const, offset: oldOffset, epoch: wall - oldOffset},
      {side: 'after' as const, offset: newOffset, epoch: wall - newOffset},
    ].sort((a, b) => a.epoch - b.epoch);

    const candidates: Candidate[] = raw.map((r, i) => {
      const ordinal = i + 1;
      const landsBefore = r.epoch < tr.atUtc; // 该候选 instant 落在过渡的哪一侧
      // shift 约定：正=时钟需前拨（读数落后于真实时间线），负=时钟需回拨（读数超前）。
      // 落在过渡前（真实生效 oldOffset）的是 after 候选，读数超前 delta -> 回拨(-delta)；
      // 落在过渡后（真实生效 newOffset）的是 before 候选，读数落后 delta -> 前拨(+delta)。
      const effective = landsBefore ? oldOffset : newOffset;
      const shift = effective - r.offset;
      const usingLabel = r.side === 'before'
        ? `过渡前偏移 ${formatOffset(oldOffset)}`
        : `过渡后偏移 ${formatOffset(newOffset)}`;
      const basis = `间隙插值：按${usingLabel}解释（该墙钟时间实际不存在）；`
        + `得到的 instant（${formatInstant(r.epoch)}）落在过渡${landsBefore ? '之前' : '之后'}，`
        + `要落到真实时间线上时钟须${shift > 0 ? '前拨' : '回拨'} ${formatDuration(Math.abs(shift))}。`;
      return {
        instant: formatInstant(r.epoch), epochSeconds: r.epoch,
        offsetSeconds: r.offset, offsetLabel: formatOffset(r.offset),
        side: r.side, occurrence: ordinal === 1 ? 'first' : 'second', ordinal,
        exists: false, wallShiftSeconds: shift, basis,
      };
    });

    const result: ResolveResult = {
      ...base, kind: 'gap', candidates,
      gap: {shiftSeconds: delta, before, after},
      transition: info, resolved: null,
    };
    result.resolved = applyGapPolicy(result, policy);
    return result;
  }

  // ---- overlap：同一墙钟时间被多个偏移段产生 ----
  const raw = matched.map(segmentIndex => {
    const seg = segments[segmentIndex];
    return {segmentIndex, offset: seg.offset, epoch: wall - seg.offset};
  }).sort((a, b) => a.epoch - b.epoch);

  const total = raw.length;
  const firstSeg = matched[0];
  const info = transitionInfo(zone, firstSeg);
  const oldOffset = info.offsetBeforeSeconds;
  const newOffset = info.offsetAfterSeconds;

  const candidates: Candidate[] = raw.map((r, i) => {
    const ordinal = i + 1;
    const side = sideFor(r.segmentIndex, matched, zone.transitions.length);
    let basis: string;
    if (total === 1) {
      basis = `唯一映射：偏移 ${formatOffset(r.offset)}。`;
    } else if (r.segmentIndex === firstSeg) {
      basis = `第 ${ordinal} 次出现：仍使用过渡前偏移 ${formatOffset(oldOffset)}（时钟回拨前的旧读数），instant 较早。`;
    } else if (r.segmentIndex === matched[matched.length - 1]) {
      basis = `第 ${ordinal} 次出现：已改用过渡后偏移 ${formatOffset(newOffset)}（时钟回拨后的新读数），instant 较晚。`;
    } else {
      basis = `第 ${ordinal} 次出现：中间偏移段，偏移 ${formatOffset(r.offset)}。`;
    }
    return {
      instant: formatInstant(r.epoch), epochSeconds: r.epoch,
      offsetSeconds: r.offset, offsetLabel: formatOffset(r.offset),
      side, occurrence: occurrenceFor(ordinal, total), ordinal,
      exists: true, wallShiftSeconds: 0, basis,
    };
  });

  const result: ResolveResult = {
    ...base, kind: 'overlap', candidates, transition: info, resolved: null,
  };
  result.resolved = applyOverlapPolicy(result, policy);
  return result;
}

function applyGapPolicy(r: ResolveResult, policy: DisambiguationPolicy): ResolvedChoice | null {
  if (policy === 'reject') return null;
  // gap：compatible 取较晚 instant；earlier 取较早；later 取较晚
  const chosen = policy === 'earlier' ? r.candidates[0] : r.candidates[r.candidates.length - 1];
  return {
    instant: chosen.instant, epochSeconds: chosen.epochSeconds,
    offsetSeconds: chosen.offsetSeconds, offsetLabel: chosen.offsetLabel, side: chosen.side,
    note: chosenNote(r.kind, policy, chosen),
    roundTripLocal: formatWall(chosen.epochSeconds + chosen.offsetSeconds),
    roundTripOk: false, // gap 插值往返必然落回一个不存在的墙钟时间
  };
}

function applyOverlapPolicy(r: ResolveResult, policy: DisambiguationPolicy): ResolvedChoice | null {
  if (policy === 'reject') return null;
  // overlap：compatible 取较早 instant（第一次出现）；later 取较晚；earlier 取较早
  const chosen = policy === 'later' ? r.candidates[r.candidates.length - 1] : r.candidates[0];
  return {
    instant: chosen.instant, epochSeconds: chosen.epochSeconds,
    offsetSeconds: chosen.offsetSeconds, offsetLabel: chosen.offsetLabel, side: chosen.side,
    note: chosenNote(r.kind, policy, chosen),
    roundTripLocal: formatWall(chosen.epochSeconds + chosen.offsetSeconds),
    roundTripOk: formatWall(chosen.epochSeconds + chosen.offsetSeconds) === r.local,
  };
}

function chosenNote(kind: ResolveKind, policy: DisambiguationPolicy, c: Candidate): string {
  const policyText: Record<DisambiguationPolicy, string> = {
    compatible: 'compatible（兼容：gap 取较晚 instant，overlap 取第一次出现）',
    earlier: 'earlier（较早 instant）',
    later: 'later（较晚 instant）',
    reject: 'reject（拒绝）',
  };
  if (kind === 'gap') {
    const dir = c.wallShiftSeconds > 0 ? '前拨' : '回拨';
    return `${policyText[policy]}：按${c.side === 'before' ? '过渡前' : '过渡后'}偏移 ${c.offsetLabel} 解释，时钟须${dir} ${formatDuration(Math.abs(c.wallShiftSeconds))}；注意该本地时间实际不存在。`;
  }
  return `${policyText[policy]}：选择第 ${c.ordinal} 次出现（偏移 ${c.offsetLabel}，${c.side === 'before' ? '过渡前旧读数' : '过渡后新读数'}）。`;
}

export function findZone(doc: BundleDoc, name: string): Zone | null {
  return doc.zones.find(z => z.name === name) ?? null;
}

export function zoneSummary(z: Zone) {
  return {
    name: z.name,
    baseOffsetSeconds: z.baseOffsetSeconds,
    baseOffsetLabel: formatOffset(z.baseOffsetSeconds),
    transitionCount: z.transitions.length,
    transitions: z.transitions.map(tr => ({
      instant: formatInstant(tr.atUtc),
      atUtc: tr.atUtc,
      offsetSeconds: tr.offsetSeconds,
      offsetLabel: formatOffset(tr.offsetSeconds),
    })),
  };
}
