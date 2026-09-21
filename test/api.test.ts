import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {
  instantToLocal, localToInstantCandidates,
  parseBundle, parseWall, resolveLocal,
} from '../src/server/tz';

const HOUR = 3_600_000;
const HALF_HOUR = 1_800_000;

function zone(text:string, name = 'Z'){
  const parsed = parseBundle(text);
  expect(parsed.errors).toEqual([]);
  const z = parsed.zones.find(v => v.name === name);
  if(!z)throw new Error(`zone ${name} missing`);
  return z;
}

describe('wall-time resolution kernel', () => {
  it('resolves a plain unique wall time with a single valid candidate', () => {
    const z = zone(`zone Z base +01:00\n2024-03-31T01:00Z +02:00\n2024-10-27T01:00Z +01:00\n`);
    // 2024-06-01T12:00 local (summer, +02:00) -> 10:00Z
    const r = resolveLocal(z, parseWall('2024-06-01T12:00')!, 'compatible');
    expect(r.kind).toBe('unique');
    expect(r.resolved!.instant).toBe(Date.parse('2024-06-01T10:00Z'));
    expect(r.candidates.filter(c => c.valid)).toHaveLength(1);
    expect(r.roundTrip?.matches).toBe(true);
    expect(r.roundTrip?.output).toBe('2024-06-01T12:00');
  });

  it('classifies a one-hour spring gap and returns both boundaries', () => {
    const z = zone(`zone Z base +01:00\n2024-03-31T01:00Z +02:00\n2024-10-27T01:00Z +01:00\n`);
    const r = localToInstantCandidates(z, parseWall('2024-03-31T02:30')!);
    expect(r.kind).toBe('gap');
    expect(r.transition).toBe(Date.parse('2024-03-31T01:00Z'));
    expect(r.gap).toMatchObject({
      startLocal: Date.parse('2024-03-31T02:00Z'),
      endLocal: Date.parse('2024-03-31T03:00Z'),
      durationMinutes: 60,
    });
    expect(r.candidates.every(c => !c.valid)).toBe(true);
    const earlier = r.candidates.find(c => c.role === 'gapEarlier')!;
    const later = r.candidates.find(c => c.role === 'gapLater')!;
    expect(earlier.instant).toBeLessThan(later.instant);
    expect(later.instant - earlier.instant).toBe(HOUR);
    expect(earlier.instant).toBe(Date.parse('2024-03-31T00:30Z'));
    expect(later.instant).toBe(Date.parse('2024-03-31T01:30Z'));
    expect(earlier.offset).toBe(120);
    expect(later.offset).toBe(60);
    expect(earlier.basis).toContain('earlier boundary');
    expect(later.basis).toContain('later boundary');
  });

  it('classifies a one-hour autumn overlap and returns both valid candidates sorted by instant', () => {
    const z = zone(`zone Z base +01:00\n2024-03-31T01:00Z +02:00\n2024-10-27T01:00Z +01:00\n`);
    const r = localToInstantCandidates(z, parseWall('2024-10-27T02:30')!);
    expect(r.kind).toBe('overlap');
    const valid = r.candidates.filter(c => c.valid);
    expect(valid).toHaveLength(2);
    expect(valid[0].instant).toBe(Date.parse('2024-10-27T00:30Z')); // +02:00 reading
    expect(valid[0].offset).toBe(120);
    expect(valid[1].instant).toBe(Date.parse('2024-10-27T01:30Z')); // +01:00 reading
    expect(valid[1].offset).toBe(60);
    expect(valid[1].instant - valid[0].instant).toBe(HOUR);
    expect(valid.every(c => c.basis.includes('is in effect'))).toBe(true);
  });

  it('handles a half-hour gap', () => {
    // Lord Howe style: +10:30 -> +11:00 at 2024-10-05T15:30Z: local gap [02:00, 02:30)
    const z = zone(`zone Z base +10:30\n2024-10-05T15:30Z +11:00\n2025-04-05T15:00Z +10:30\n`);
    const r = localToInstantCandidates(z, parseWall('2024-10-06T02:15')!);
    expect(r.kind).toBe('gap');
    expect(r.gap).toMatchObject({durationMinutes: 30,
      startLocal: Date.parse('2024-10-06T02:00Z'), endLocal: Date.parse('2024-10-06T02:30Z')});
    const earlier = r.candidates.find(c => c.role === 'gapEarlier')!;
    const later = r.candidates.find(c => c.role === 'gapLater')!;
    expect(later.instant - earlier.instant).toBe(HALF_HOUR);
  });

  it('handles a half-hour overlap', () => {
    const z = zone(`zone Z base +10:30\n2024-10-05T15:30Z +11:00\n2025-04-05T15:00Z +10:30\n`);
    // Back to +10:30 at 2025-04-05T15:00Z: local 01:30-02:00 happens twice.
    const r = localToInstantCandidates(z, parseWall('2025-04-06T01:45')!);
    expect(r.kind).toBe('overlap');
    const valid = r.candidates.filter(c => c.valid);
    expect(valid).toHaveLength(2);
    expect(valid[1].instant - valid[0].instant).toBe(HALF_HOUR);
  });

  it('walks a sequence of consecutive historical transitions independently', () => {
    const z = zone(`zone Z base +01:00
2024-03-31T01:00Z +02:00
2024-10-27T01:00Z +01:00
2025-03-30T01:00Z +02:00
2025-10-26T01:00Z +01:00
`);
    expect(resolveLocal(z, parseWall('2024-03-31T02:30')!, 'reject').kind).toBe('gap');
    expect(resolveLocal(z, parseWall('2024-10-27T02:30')!, 'reject').kind).toBe('overlap');
    expect(resolveLocal(z, parseWall('2025-03-30T02:30')!, 'reject').kind).toBe('gap');
    expect(resolveLocal(z, parseWall('2025-10-26T02:30')!, 'reject').kind).toBe('overlap');
    // A winter date between transitions is unique and round-trips.
    const winter = resolveLocal(z, parseWall('2025-01-15T08:00')!, 'compatible');
    expect(winter.kind).toBe('unique');
    expect(winter.roundTrip?.matches).toBe(true);
  });

  it('treats exact gap/overlap boundaries consistently (right-continuous segments)', () => {
    const z = zone(`zone Z base +01:00\n2024-03-31T01:00Z +02:00\n2024-10-27T01:00Z +01:00\n`);
    // Gap: 02:00 is the first skipped wall time (no valid mapping), 03:00 exists once.
    expect(localToInstantCandidates(z, parseWall('2024-03-31T02:00')!).kind).toBe('gap');
    expect(localToInstantCandidates(z, parseWall('2024-03-31T03:00')!).kind).toBe('unique');
    // Overlap: 02:00 is the first repeated wall time, 03:00 occurs once under +01:00.
    expect(localToInstantCandidates(z, parseWall('2024-10-27T02:00')!).kind).toBe('overlap');
    expect(localToInstantCandidates(z, parseWall('2024-10-27T03:00')!).kind).toBe('unique');
  });

  it('supports negative DST (southern hemisphere, clocks forward in October)', () => {
    // -03:00 -> -02:00 (forward, gap) at 2024-10-06T04:00Z: local 01:00-02:00 missing
    const z = zone(`zone Z base -03:00\n2024-10-06T04:00Z -02:00\n2025-04-06T03:00Z -03:00\n`);
    const gap = localToInstantCandidates(z, parseWall('2024-10-06T01:30')!);
    expect(gap.kind).toBe('gap');
    expect(gap.gap).toMatchObject({durationMinutes: 60,
      startLocal: Date.parse('2024-10-06T01:00Z'), endLocal: Date.parse('2024-10-06T02:00Z')});
    // Back to -03:00 at 2025-04-06T03:00Z: local 00:00-01:00 repeats.
    const overlap = localToInstantCandidates(z, parseWall('2025-04-06T00:30')!);
    expect(overlap.kind).toBe('overlap');
    expect(overlap.candidates.filter(c => c.valid).map(c => c.offset).sort((a,b)=>a-b)).toEqual([-180,-120]);
  });

  it('returns a unique result for zones with no transitions', () => {
    const z = zone(`zone Z base +05:30\n`);
    const r = resolveLocal(z, parseWall('2024-06-01T11:00')!, 'reject');
    expect(r.kind).toBe('unique');
    expect(r.resolved).toEqual({instant: Date.parse('2024-06-01T05:30Z'), offset: 330});
    expect(r.rejected).toBe(false);
    expect(r.roundTrip?.matches).toBe(true);
    expect(r.candidates).toHaveLength(1);
  });

  it('applies all four policies for gaps and overlaps server-side', () => {
    const z = zone(`zone Z base +01:00\n2024-03-31T01:00Z +02:00\n2024-10-27T01:00Z +01:00\n`);
    const gapWall = parseWall('2024-03-31T02:30')!;
    expect(resolveLocal(z, gapWall, 'compatible').resolved!.instant).toBe(Date.parse('2024-03-31T01:30Z'));
    expect(resolveLocal(z, gapWall, 'later').resolved!.instant).toBe(Date.parse('2024-03-31T01:30Z'));
    expect(resolveLocal(z, gapWall, 'earlier').resolved!.instant).toBe(Date.parse('2024-03-31T00:30Z'));
    expect(resolveLocal(z, gapWall, 'reject').rejected).toBe(true);
    expect(resolveLocal(z, gapWall, 'reject').resolved).toBeNull();

    const overlapWall = parseWall('2024-10-27T02:30')!;
    expect(resolveLocal(z, overlapWall, 'compatible').resolved!.offset).toBe(120);
    expect(resolveLocal(z, overlapWall, 'earlier').resolved!.offset).toBe(120);
    expect(resolveLocal(z, overlapWall, 'later').resolved!.offset).toBe(60);
    expect(resolveLocal(z, overlapWall, 'reject').rejected).toBe(true);
  });

  it('round-trips every unique instant back to the same wall time', () => {
    const z = zone(`zone Z base +10:30\n2024-10-05T15:30Z +11:00\n2025-04-05T15:00Z +10:30\n`);
    for(const local of ['2024-08-01T12:00','2024-12-31T23:59','2025-06-01T00:30']){
      const r = resolveLocal(z, parseWall(local)!, 'compatible');
      expect(r.kind, local).toBe('unique');
      expect(r.roundTrip?.matches, local).toBe(true);
      expect(instantToLocal(z, r.resolved!.instant).wall).toBe(local);
    }
  });

  it('rejects malformed bundles and wall inputs', () => {
    expect(parseBundle(`zone Z base +01:00\n2024-01-01T00:00Z nope\n`).errors.length).toBeGreaterThan(0);
    expect(parseBundle(`zone Z base +01:00\n2024-02-01T00:00Z +02:00\n2024-01-01T00:00Z +03:00\n`).errors.length).toBeGreaterThan(0);
    expect(parseWall('2024-02-30T12:00')).toBeNull();
    expect(parseWall('not a date')).toBeNull();
  });
});

describe('service http api', () => {
  it('converts unique, gap and overlap wall times', async () => {
    const app = createApp();
    const unique = await request(app).get('/api/convert?bundle=alpha&zone=Alpha/OneHour&local=2024-06-01T12:00').expect(200);
    expect(unique.body.kind).toBe('unique');
    expect(unique.body.resolved.instant).toBe('2024-06-01T10:00Z');
    expect(unique.body.roundTrip.matches).toBe(true);

    const gap = await request(app).get('/api/convert?bundle=alpha&zone=Alpha/OneHour&local=2024-03-31T02:30').expect(200);
    expect(gap.body.kind).toBe('gap');
    expect(gap.body.gap.startLocal).toBe('2024-03-31T02:00');
    expect(gap.body.gap.endLocal).toBe('2024-03-31T03:00');
    expect(gap.body.candidates).toHaveLength(2);
    expect(gap.body.candidates[0].instant < gap.body.candidates[1].instant).toBe(true);
    expect(gap.body.resolved.instant).toBe('2024-03-31T01:30Z'); // compatible => later boundary

    const overlap = await request(app).get('/api/convert?bundle=alpha&zone=Alpha/OneHour&local=2024-10-27T02:30').expect(200);
    expect(overlap.body.kind).toBe('overlap');
    expect(overlap.body.candidates.filter((c:any)=>c.valid)).toHaveLength(2);
  });

  it('converts half-hour and negative-DST zones', async () => {
    const app = createApp();
    const half = await request(app).get('/api/convert?bundle=beta&zone=Beta/HalfHour&local=2024-10-06T02:15').expect(200);
    expect(half.body.kind).toBe('gap');
    expect(half.body.gap.durationMinutes).toBe(30);
    const overlap = await request(app).get('/api/convert?bundle=beta&zone=Beta/HalfHour&local=2025-04-06T01:45').expect(200);
    expect(overlap.body.kind).toBe('overlap');
    expect(overlap.body.candidates.filter((c:any)=>c.valid)).toHaveLength(2);
    const neg = await request(app).get('/api/convert?bundle=beta&zone=Beta/Negative&local=2024-10-06T01:30').expect(200);
    expect(neg.body.kind).toBe('gap');
    const fixed = await request(app).get('/api/convert?bundle=alpha&zone=Alpha/Fixed&local=2024-01-01T00:00').expect(200);
    expect(fixed.body.kind).toBe('unique');
  });

  it('applies policies via query parameter', async () => {
    const app = createApp();
    const rejected = await request(app).get('/api/convert?bundle=alpha&zone=Alpha/OneHour&local=2024-03-31T02:30&policy=reject').expect(200);
    expect(rejected.body.rejected).toBe(true);
    expect(rejected.body.resolved).toBeNull();
    const earlier = await request(app).get('/api/convert?bundle=alpha&zone=Alpha/OneHour&local=2024-10-27T02:30&policy=earlier').expect(200);
    expect(earlier.body.resolved.offset).toBe('+02:00');
    const later = await request(app).get('/api/convert?bundle=alpha&zone=Alpha/OneHour&local=2024-10-27T02:30&policy=later').expect(200);
    expect(later.body.resolved.offset).toBe('+01:00');
  });

  it('serves zone metadata with bundle revision', async () => {
    const app = createApp();
    const meta = await request(app).get('/api/bundles/alpha/zones').expect(200);
    expect(meta.body.revision).toBe(3);
    expect(meta.body.zones.map((z:any)=>z.name)).toEqual(['Alpha/OneHour','Alpha/Fixed']);
    expect(meta.body.zones[0].transitions).toHaveLength(4);
    expect(meta.header['etag']).toBe('3');
  });

  it('reflects zone conversions after a bundle revision update', async () => {
    const app = createApp();
    const before = await request(app).get('/api/bundles/alpha').expect(200);
    const content = `zone Alpha/OneHour base +04:00\n2024-01-01T00:00Z +05:00\n`;
    const saved = await request(app).put('/api/bundles/alpha')
      .send({content, revision: before.body.revision}).expect(200);
    expect(saved.body.revision).toBe(4);
    // stale revision conflicts
    await request(app).put('/api/bundles/alpha').send({content:'x', revision:3}).expect(409);
    const zones = await request(app).get('/api/bundles/alpha/zones').expect(200);
    expect(zones.body.revision).toBe(4);
    expect(zones.body.zones[0].base).toBe('+04:00');
    const gap = await request(app).get('/api/convert?bundle=alpha&zone=Alpha/OneHour&local=2024-01-01T04:30').expect(200);
    expect(gap.body.kind).toBe('gap');
    expect(gap.body.revision).toBe(4);
    // old zone removed after edit
    await request(app).get('/api/convert?bundle=alpha&zone=Alpha/Fixed&local=2024-01-01T00:00').expect(404);
  });

  it('returns errors for unknown bundles, zones or bad wall input', async () => {
    const app = createApp();
    await request(app).get('/api/convert?bundle=nope&zone=Z&local=2024-01-01T00:00').expect(404);
    const badZone = await request(app).get('/api/convert?bundle=alpha&zone=Nope&local=2024-01-01T00:00').expect(404);
    expect(badZone.body.available).toContain('Alpha/OneHour');
    await request(app).get('/api/convert?bundle=alpha&zone=Alpha/OneHour&local=banana').expect(400);
  });

  it('still conditionally updates records and runs analysis', async () => {
    const app = createApp();
    const analysis = await request(app).post('/api/bundles/beta/analyze').send({}).expect(200);
    expect(analysis.body.zones.map((z:any)=>z.name)).toEqual(['Beta/HalfHour','Beta/Negative']);
    expect(analysis.body.zones[0].transitions).toHaveLength(2);
    const before = await request(app).get('/api/bundles/beta').expect(200);
    await request(app).put('/api/bundles/beta').send({content:'updated', revision:before.body.revision}).expect(200);
    await request(app).put('/api/bundles/beta').send({content:'stale', revision:before.body.revision}).expect(409);
    // parse diagnostics surface in analysis
    const bad = await request(app).post('/api/bundles/beta/analyze').send({content:'zone Z base +01:00\nbanana'}).expect(200);
    expect(bad.body.diagnostics.length).toBeGreaterThan(0);
  });
});
