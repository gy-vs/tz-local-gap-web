import {describe, expect, it, beforeEach} from 'vitest';
import request from 'supertest';
import {createApp, resetRows} from '../src/server/index';
import {parseBundle, resolveLocal, findZone, formatInstant, type DisambiguationPolicy} from '../src/server/tz';

function doc(content: string) {
  const d = parseBundle(content);
  expect(d.diagnostics.filter(x => x.level === 'error')).toEqual([]);
  return d;
}

// Demo/East：整小时、连续历史过渡（2023+2024）
const EAST_BUNDLE = `
zone Demo/East -05:00
at 2023-03-12T07:00:00Z -04:00
at 2023-11-05T06:00:00Z -05:00
at 2024-03-10T07:00:00Z -04:00
at 2024-11-03T06:00:00Z -05:00
`;

// 半小时过渡
const HALF_BUNDLE = `
zone Demo/Half +10:30
at 2024-10-06T16:00:00Z +11:00
at 2025-04-05T16:00:00Z +10:30
`;

// 负 DST（类爱尔兰）：春季回拨 -> 重叠，秋季前拨 -> 间隙
const NEG_BUNDLE = `
zone Demo/Neg +01:00
at 2024-03-31T01:00:00Z +00:00
at 2024-10-27T01:00:00Z +01:00
`;

describe('resolveLocal - 整小时 gap/overlap', () => {
  const east = findZone(doc(EAST_BUNDLE), 'Demo/East')!;

  it('普通时间 unique 且往返一致', () => {
    const r = resolveLocal(east, '2024-01-15T12:00:00', 'compatible');
    expect(r.kind).toBe('unique');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].instant).toBe('2024-01-15T17:00:00Z');
    expect(r.resolved?.roundTripOk).toBe(true);
    expect(r.resolved?.roundTripLocal).toBe('2024-01-15T12:00:00');
  });

  it('春季 02:30 是 gap：被明确标记、提供两个边界', () => {
    const r = resolveLocal(east, '2024-03-10T02:30:00', 'compatible');
    expect(r.kind).toBe('gap');
    expect(r.resolved).not.toBeNull();
    expect(r.gap?.before.local).toBe('2024-03-10T02:00:00');
    expect(r.gap?.after.local).toBe('2024-03-10T03:00:00');
    expect(r.gap?.before.instant).toBe('2024-03-10T07:00:00Z');
    expect(r.gap?.after.instant).toBe('2024-03-10T07:00:00Z'); // 两侧映射到同一瞬间
    expect(r.gap?.before.offsetLabel).toBe('-05:00');
    expect(r.gap?.after.offsetLabel).toBe('-04:00');
    expect(r.gap?.shiftSeconds).toBe(3600);
  });

  it('gap 候选均为插值（exists=false）且按 instant 升序', () => {
    const r = resolveLocal(east, '2024-03-10T02:30:00', 'compatible');
    expect(r.candidates.map(c => c.instant)).toEqual([
      '2024-03-10T06:30:00Z', // 用 -04:00 解释，落在过渡之前
      '2024-03-10T07:30:00Z', // 用 -05:00 解释，落在过渡之后
    ]);
    expect(r.candidates.every(c => c.exists === false)).toBe(true);
    expect(r.candidates[0].epochSeconds).toBeLessThan(r.candidates[1].epochSeconds);
    // 时钟修正方向：较早候选读数超前（回拨，负），较晚候选读数落后（前拨，正）
    expect(r.candidates[0].wallShiftSeconds).toBe(-3600);
    expect(r.candidates[1].wallShiftSeconds).toBe(3600);
    expect(r.candidates.every(c => c.basis.length > 0)).toBe(true);
  });

  it('gap 恰好边界：02:00 属于 gap，03:00 已经 unique', () => {
    const start = resolveLocal(east, '2024-03-10T02:00:00', 'reject');
    expect(start.kind).toBe('gap');
    const end = resolveLocal(east, '2024-03-10T03:00:00', 'reject');
    expect(end.kind).toBe('unique');
    expect(end.candidates[0].offsetLabel).toBe('-04:00');
  });

  it('秋季 01:30 是 overlap：返回全部两个真实候选，按 instant 升序', () => {
    const r = resolveLocal(east, '2024-11-03T01:30:00', 'compatible');
    expect(r.kind).toBe('overlap');
    expect(r.candidates.map(c => c.instant)).toEqual([
      '2024-11-03T05:30:00Z',
      '2024-11-03T06:30:00Z',
    ]);
    expect(r.candidates.map(c => c.offsetLabel)).toEqual(['-04:00', '-05:00']);
    expect(r.candidates.map(c => c.side)).toEqual(['before', 'after']);
    expect(r.candidates.map(c => c.occurrence)).toEqual(['first', 'second']);
    expect(r.candidates.every(c => c.exists)).toBe(true);
    expect(r.candidates.every(c => c.basis)).not.toContain('');
  });

  it('overlap 恰好边界：01:00 仍重叠（含起始边界），02:00 unique', () => {
    const at = resolveLocal(east, '2024-11-03T01:00:00', 'reject');
    expect(at.kind).toBe('overlap');
    const after = resolveLocal(east, '2024-11-03T02:00:00', 'reject');
    expect(after.kind).toBe('unique');
    expect(after.candidates[0].offsetLabel).toBe('-05:00');
  });

  it('两个 overlap 候选各自往返都等于输入墙钟', () => {
    const r = resolveLocal(east, '2024-11-03T01:30:00', 'reject');
    for (const c of r.candidates) {
      const back = formatInstant(c.epochSeconds); // sanity
      expect(back).toMatch(/Z$/);
    }
    const early = resolveLocal(east, '2024-11-03T01:30:00', 'earlier');
    const late = resolveLocal(east, '2024-11-03T01:30:00', 'later');
    expect(early.resolved?.instant).toBe('2024-11-03T05:30:00Z');
    expect(late.resolved?.instant).toBe('2024-11-03T06:30:00Z');
    expect(early.resolved?.roundTripOk && late.resolved?.roundTripOk).toBe(true);
  });
});

describe('四种消歧策略在服务端统一生效', () => {
  const east = findZone(doc(EAST_BUNDLE), 'Demo/East')!;
  const gapLocal = '2024-03-10T02:30:00';
  const overlapLocal = '2024-11-03T01:30:00';

  it('compatible：gap 取较晚 instant，overlap 取较早 instant', () => {
    expect(resolveLocal(east, gapLocal, 'compatible').resolved?.instant).toBe('2024-03-10T07:30:00Z');
    expect(resolveLocal(east, overlapLocal, 'compatible').resolved?.instant).toBe('2024-11-03T05:30:00Z');
  });

  it('earlier：始终取按 instant 排序的第一个候选', () => {
    expect(resolveLocal(east, gapLocal, 'earlier').resolved?.instant).toBe('2024-03-10T06:30:00Z');
    expect(resolveLocal(east, overlapLocal, 'earlier').resolved?.instant).toBe('2024-11-03T05:30:00Z');
  });

  it('later：始终取最后一个候选', () => {
    expect(resolveLocal(east, gapLocal, 'later').resolved?.instant).toBe('2024-03-10T07:30:00Z');
    expect(resolveLocal(east, overlapLocal, 'later').resolved?.instant).toBe('2024-11-03T06:30:00Z');
  });

  it('reject：gap/overlap 均不裁决，unique 不受影响', () => {
    expect(resolveLocal(east, gapLocal, 'reject').resolved).toBeNull();
    expect(resolveLocal(east, overlapLocal, 'reject').resolved).toBeNull();
    const u = resolveLocal(east, '2024-07-01T12:00:00', 'reject');
    expect(u.kind).toBe('unique');
    expect(u.resolved?.instant).toBe('2024-07-01T16:00:00Z');
  });

  it('策略结果携带的偏移与候选一致（前端无需加减小时）', () => {
    for (const p of ['compatible', 'earlier', 'later'] as DisambiguationPolicy[]) {
      const g = resolveLocal(east, gapLocal, p);
      expect(g.candidates.some(c => c.instant === g.resolved?.instant && c.offsetLabel === g.resolved?.offsetLabel)).toBe(true);
      const o = resolveLocal(east, overlapLocal, p);
      expect(o.candidates.some(c => c.instant === o.resolved?.instant && c.offsetLabel === o.resolved?.offsetLabel)).toBe(true);
    }
  });
});

describe('半小时（非整小时）过渡', () => {
  const half = findZone(doc(HALF_BUNDLE), 'Demo/Half')!;

  it('春季半小时 gap', () => {
    const r = resolveLocal(half, '2024-10-07T02:45:00', 'compatible');
    expect(r.kind).toBe('gap');
    expect(r.gap?.shiftSeconds).toBe(1800);
    expect(r.gap?.before.local).toBe('2024-10-07T02:30:00');
    expect(r.gap?.after.local).toBe('2024-10-07T03:00:00');
    expect(r.candidates.map(c => c.instant)).toEqual([
      '2024-10-06T15:45:00Z',
      '2024-10-06T16:15:00Z',
    ]);
    expect(r.candidates.map(c => c.offsetLabel)).toEqual(['+11:00', '+10:30']);
  });

  it('秋季半小时 overlap', () => {
    const r = resolveLocal(half, '2025-04-06T02:45:00', 'reject');
    expect(r.kind).toBe('overlap');
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map(c => c.instant)).toEqual([
      '2025-04-05T15:45:00Z',
      '2025-04-05T16:15:00Z',
    ]);
    expect(r.candidates.map(c => c.offsetLabel)).toEqual(['+11:00', '+10:30']);
  });

  it('半小时边界内外', () => {
    expect(resolveLocal(half, '2024-10-07T02:30:00', 'reject').kind).toBe('gap');
    expect(resolveLocal(half, '2024-10-07T03:00:00', 'reject').kind).toBe('unique');
    expect(resolveLocal(half, '2024-10-07T02:00:00', 'reject').kind).toBe('unique');
    expect(resolveLocal(half, '2025-04-06T02:30:00', 'reject').kind).toBe('overlap');
    expect(resolveLocal(half, '2025-04-06T03:00:00', 'reject').kind).toBe('unique');
  });
});

describe('负 DST（偏移变化方向反转）', () => {
  const neg = findZone(doc(NEG_BUNDLE), 'Demo/Neg')!;

  it('春季回拨产生 overlap，较早/较晚候选仍按 instant 升序', () => {
    const r = resolveLocal(neg, '2024-03-31T01:30:00', 'reject');
    expect(r.kind).toBe('overlap');
    // 较早 instant 是过渡前偏移（+01:00）的第二次映射，较晚 instant 是过渡后 +00:00
    expect(r.candidates.map(c => c.offsetLabel)).toEqual(['+01:00', '+00:00']);
    expect(r.candidates.map(c => c.instant)).toEqual([
      '2024-03-31T00:30:00Z',
      '2024-03-31T01:30:00Z',
    ]);
    expect(r.candidates.map(c => c.side)).toEqual(['before', 'after']);
    expect(r.candidates[0].epochSeconds).toBeLessThan(r.candidates[1].epochSeconds);
    // 策略仍按 instant 选取，不依赖偏移方向
    expect(resolveLocal(neg, '2024-03-31T01:30:00', 'earlier').resolved?.instant).toBe('2024-03-31T00:30:00Z');
    expect(resolveLocal(neg, '2024-03-31T01:30:00', 'later').resolved?.instant).toBe('2024-03-31T01:30:00Z');
  });

  it('秋季前拨产生 gap，候选顺序自动随 instant 排列', () => {
    const r = resolveLocal(neg, '2024-10-27T01:30:00', 'reject');
    expect(r.kind).toBe('gap');
    expect(r.gap?.shiftSeconds).toBe(3600);
    expect(r.candidates.map(c => c.offsetLabel)).toEqual(['+01:00', '+00:00']);
    expect(r.candidates[0].epochSeconds).toBeLessThan(r.candidates[1].epochSeconds);
  });
});

describe('连续历史过渡与无过渡 zone', () => {
  const east = findZone(doc(EAST_BUNDLE), 'Demo/East')!;

  it('2023 与 2024 的过渡分别正确', () => {
    expect(resolveLocal(east, '2023-03-12T02:30:00', 'reject').kind).toBe('gap');
    expect(resolveLocal(east, '2023-11-05T01:30:00', 'reject').kind).toBe('overlap');
    expect(resolveLocal(east, '2024-03-10T02:30:00', 'reject').kind).toBe('gap');
    expect(resolveLocal(east, '2024-11-03T01:30:00', 'reject').kind).toBe('overlap');
  });

  it('首个过渡之前与最后过渡之后都 unique', () => {
    const pre = resolveLocal(east, '2020-01-01T00:00:00', 'reject');
    expect(pre.kind).toBe('unique');
    expect(pre.candidates[0].offsetLabel).toBe('-05:00');
    const post = resolveLocal(east, '2030-07-01T00:00:00', 'reject');
    expect(post.kind).toBe('unique');
    expect(post.candidates[0].offsetLabel).toBe('-05:00'); // 最后一条过渡是 2024 秋季回拨
  });

  it('无过渡 zone 任意时间 unique 且往返一致', () => {
    const fixed = findZone(doc('zone Demo/Fixed +05:30'), 'Demo/Fixed')!;
    for (const local of ['1900-01-01T00:00:00', '2024-02-29T12:34:56', '2100-12-31T23:59:59']) {
      const r = resolveLocal(fixed, local, 'reject');
      expect(r.kind).toBe('unique');
      expect(r.resolved?.roundTripOk).toBe(true);
      expect(r.resolved?.roundTripLocal).toBe(local);
    }
    expect(resolveLocal(fixed, '2024-01-01T00:00:00', 'reject').resolved?.instant).toBe('2023-12-31T18:30:00Z');
  });

  it('倒序的过渡行只产生 warning 并被自动排序', () => {
    const d = parseBundle('zone Z Z\nat 2025-01-01T00:00:00Z +02:00\nat 2024-01-01T00:00:00Z +01:00');
    expect(d.diagnostics.some(x => x.code === 'transition_out_of_order')).toBe(true);
    expect(d.diagnostics.some(x => x.level === 'error')).toBe(false);
    const z = d.zones[0];
    expect(z.transitions.map(t => t.atUtc)).toEqual([
      Date.parse('2024-01-01T00:00:00Z') / 1000,
      Date.parse('2025-01-01T00:00:00Z') / 1000,
    ]);
  });
});

describe('HTTP API', () => {
  beforeEach(() => { resetRows(); });

  it('bootstrap 暴露策略列表', async () => {
    const app = createApp();
    const r = await request(app).get('/api/bootstrap').expect(200);
    expect(r.body.policies).toEqual(['compatible', 'earlier', 'later', 'reject']);
  });

  it('resolve：gap/overlap/unique 三类返回完整结构', async () => {
    const app = createApp();
    const gap = await request(app).post('/api/bundles/alpha/resolve')
      .send({zone: 'Demo/East', local: '2024-03-10 02:30:00', policy: 'compatible'}).expect(200);
    expect(gap.body.result.kind).toBe('gap');
    expect(gap.body.result.candidates).toHaveLength(2);
    expect(gap.body.result.gap.before.local).toBe('2024-03-10T02:00:00');
    expect(gap.body.result.resolved.instant).toBe('2024-03-10T07:30:00Z');

    const overlap = await request(app).post('/api/bundles/alpha/resolve')
      .send({zone: 'Demo/East', local: '2024-11-03T01:30:00', policy: 'reject'}).expect(200);
    expect(overlap.body.result.kind).toBe('overlap');
    expect(overlap.body.result.resolved).toBeNull();
    expect(overlap.body.result.candidates.map((c: any) => c.instant)).toEqual([
      '2024-11-03T05:30:00Z', '2024-11-03T06:30:00Z',
    ]);

    const unique = await request(app).post('/api/bundles/alpha/resolve')
      .send({zone: 'Demo/Fixed', local: '2024-06-01T08:00:00', policy: 'reject'}).expect(200);
    expect(unique.body.result.kind).toBe('unique');
    expect(unique.body.result.resolved.roundTripOk).toBe(true);
  });

  it('半小时 / 负 DST zone 经 API 可解析', async () => {
    const app = createApp();
    const half = await request(app).post('/api/bundles/alpha/resolve')
      .send({zone: 'Demo/Half', local: '2024-10-07T02:45:00', policy: 'earlier'}).expect(200);
    expect(half.body.result.kind).toBe('gap');
    expect(half.body.result.resolved.instant).toBe('2024-10-06T15:45:00Z');
    const neg = await request(app).post('/api/bundles/alpha/resolve')
      .send({zone: 'Demo/Neg', local: '2024-03-31T01:30:00', policy: 'later'}).expect(200);
    expect(neg.body.result.kind).toBe('overlap');
    expect(neg.body.result.candidates).toHaveLength(2);
  });

  it('未知 zone、非法本地时间、非法策略分别报错', async () => {
    const app = createApp();
    await request(app).post('/api/bundles/alpha/resolve')
      .send({zone: 'Nope', local: '2024-01-01T00:00:00', policy: 'compatible'}).expect(400);
    await request(app).post('/api/bundles/alpha/resolve')
      .send({zone: 'Demo/East', local: 'not-a-time', policy: 'compatible'}).expect(400);
    await request(app).post('/api/bundles/alpha/resolve')
      .send({zone: 'Demo/East', local: '2024-01-01T00:00:00', policy: 'guess'}).expect(400);
    await request(app).post('/api/bundles/nope/resolve')
      .send({zone: 'Demo/East', local: '2024-01-01T00:00:00', policy: 'compatible'}).expect(404);
  });

  it('bundle revision：乐观更新、冲突 409、更新后解析反映新内容', async () => {
    const app = createApp();
    const before = await request(app).get('/api/bundles/beta').expect(200);
    const rev = before.body.revision;
    const content = 'zone Demo/Beta Z\nat 2026-03-01T01:00:00Z +02:00\n';
    const saved = await request(app).put('/api/bundles/beta').send({content, revision: rev}).expect(200);
    expect(saved.body.revision).toBe(rev + 1);
    // 旧 revision 再提交 -> 冲突
    await request(app).put('/api/bundles/beta').send({content, revision: rev}).expect(409);
    // 新内容立刻体现在解析与 zones 列表
    const zones = await request(app).get('/api/bundles/beta/zones').expect(200);
    expect(zones.body.zones[0].name).toBe('Demo/Beta');
    expect(zones.body.revision).toBe(rev + 1);
    const r = await request(app).post('/api/bundles/beta/resolve')
      .send({zone: 'Demo/Beta', local: '2026-03-01T01:30:00', policy: 'reject'}).expect(200);
    expect(r.body.result.kind).toBe('gap');
    expect(r.body.revision).toBe(rev + 1);
  });

  it('保存含语法错误的 bundle 被 422 拒绝且 revision 不变', async () => {
    const app = createApp();
    const before = await request(app).get('/api/bundles/beta').expect(200);
    const bad = 'zone Demo/Beta Z\nnonsense line here\n';
    const r = await request(app).put('/api/bundles/beta').send({content: bad, revision: before.body.revision}).expect(422);
    expect(r.body.error).toBe('invalid_bundle');
    expect(r.body.diagnostics.some((d: any) => d.code === 'unparsable_line')).toBe(true);
    const again = await request(app).get('/api/bundles/beta').expect(200);
    expect(again.body.revision).toBe(before.body.revision);
  });

  it('analyze 返回诊断与 zone 摘要（倒序过渡 warning）', async () => {
    const app = createApp();
    const r = await request(app).post('/api/bundles/alpha/analyze').send({}).expect(200);
    expect(r.body.zones.map((z: any) => z.name)).toEqual(['Demo/East', 'Demo/Half', 'Demo/Neg', 'Demo/Fixed']);
    expect(r.body.zones[0].transitionCount).toBe(4);
    const beta = await request(app).post('/api/bundles/beta/analyze').send({}).expect(200);
    expect(beta.body.diagnostics.some((d: any) => d.code === 'transition_out_of_order')).toBe(true);
  });
});
