// Timezone bundle parsing and wall-time -> instant resolution.
//
// Bundle text format (line based, '#' starts a comment):
//   zone <name> base <offset>
//   <utc-instant> <offset>
//
// Offsets are total UTC offsets (standard + DST) in [+-]HH[:mm]. Each
// transition names the absolute UTC instant at which a new offset starts.
// A segment is right-continuous: segment i covers instants [at_i, at_{i+1});
// segment 0 (the base) covers (-Inf, at_1).

export type Segment = {at:number; offset:number};
export type Zone = {name:string; segments:Segment[]};
export type ParseResult = {zones:Zone[]; errors:string[]};

export type CandidateRole = 'valid' | 'gapEarlier' | 'gapLater' | 'invalid';
export type Candidate = {
  instant:number;
  offset:number;
  valid:boolean;
  role:CandidateRole;
  basis:string;
};

export type Kind = 'unique' | 'gap' | 'overlap';
export type Policy = 'compatible' | 'earlier' | 'later' | 'reject';
export const POLICIES:readonly Policy[] = ['compatible','earlier','later','reject'] as const;

export type GapBounds = {
  transition:number;
  offsetBefore:number;
  offsetAfter:number;
  startLocal:number; // first wall time that does not exist
  endLocal:number;   // first wall time that exists again
  durationMinutes:number;
};

export type ConversionResult = {
  kind:Kind;
  policy:Policy;
  transition:number | null;
  gap:GapBounds | null;
  candidates:Candidate[];
  resolved:{instant:number; offset:number} | null;
  rejected:boolean;
  roundTrip:{input:string; output:string; matches:boolean} | null;
};

export function parseBundle(text:string):ParseResult{
  const zones:Zone[] = [];
  const errors:string[] = [];
  let current:Zone | null = null;
  text.split(/\r?\n/).forEach((raw,index)=>{
    const lineNumber = index + 1;
    const line = raw.replace(/#.*$/,'').trim();
    if(!line)return;
    const tokens = line.split(/\s+/);
    if(tokens[0] === 'zone'){
      if(tokens.length < 4 || tokens[2] !== 'base'){
        errors.push(`line ${lineNumber}: expected "zone <name> base <offset>"`);
        current = null;
        return;
      }
      const base = parseOffset(tokens[3]);
      if(base === null){
        errors.push(`line ${lineNumber}: invalid offset "${tokens[3]}"`);
        current = null;
        return;
      }
      current = {name:tokens[1], segments:[{at:-Infinity, offset:base}]};
      zones.push(current);
      return;
    }
    if(!current){
      errors.push(`line ${lineNumber}: transition outside of a zone`);
      return;
    }
    if(tokens.length < 2){
      errors.push(`line ${lineNumber}: expected "<instant> <offset>"`);
      return;
    }
    const at = parseInstant(tokens[0]);
    const offset = parseOffset(tokens[1]);
    if(at === null){
      errors.push(`line ${lineNumber}: invalid instant "${tokens[0]}"`);
      return;
    }
    if(offset === null){
      errors.push(`line ${lineNumber}: invalid offset "${tokens[1]}"`);
      return;
    }
    const last = current.segments[current.segments.length - 1];
    if(Number.isFinite(last.at) && at <= last.at){
      errors.push(`line ${lineNumber}: transitions must be strictly increasing`);
      return;
    }
    if(offset === last.offset)return; // no effective change
    current.segments.push({at, offset});
  });
  return {zones, errors};
}

export function parseOffset(text:string):number | null{
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text);
  if(!match)return null;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if(hours > 23 || minutes > 59)return null;
  const total = hours * 60 + minutes;
  return match[1] === '-' ? -total : total;
}

export function parseInstant(text:string):number | null{
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/.test(text))return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

// Parses the wall time exactly as written ("YYYY-MM-DDTHH:mm[:ss]"),
// without applying any timezone.
export function parseWall(text:string):number | null{
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if(!match)return null;
  const [, y, mo, d, h, mi, s] = match;
  const epochMs = Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
  // Reject normalised overflow such as 2024-02-30.
  const check = new Date(epochMs);
  if(check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 ||
    check.getUTCDate() !== +d || check.getUTCHours() !== +(h ?? 0) ||
    check.getUTCMinutes() !== +(mi ?? 0) || check.getUTCSeconds() !== +(s ?? 0)){
    return null;
  }
  return epochMs;
}

export function findZone(result:ParseResult, name:string):Zone | undefined{
  return result.zones.find(zone => zone.name === name);
}

// Segment in effect at an absolute instant (right-continuous boundaries).
export function segmentAt(zone:Zone, instant:number):Segment{
  let current = zone.segments[0];
  for(const segment of zone.segments){
    if(instant >= segment.at)current = segment;
    else break;
  }
  return current;
}

function segmentIndex(zone:Zone, segment:Segment):number{
  return zone.segments.indexOf(segment);
}

function segmentBasis(zone:Zone, segment:Segment):string{
  const i = segmentIndex(zone, segment);
  const start = i === 0 ? 'the zone baseline' : `at ${formatInstant(segment.at)}`;
  const next = zone.segments[i + 1];
  const end = next ? formatInstant(next.at) : 'onwards';
  return `offset ${formatOffset(segment.offset)} is in effect from ${start} until ${end}`;
}

function findTransitionWindow(zone:Zone, wallMs:number):{index:number; lo:number; hi:number} | null{
  for(let i = 1; i < zone.segments.length; i++){
    const at = zone.segments[i].at;
    const oBefore = zone.segments[i - 1].offset;
    const oAfter = zone.segments[i].offset;
    const lo = Math.min(at + oBefore * 60_000, at + oAfter * 60_000);
    const hi = Math.max(at + oBefore * 60_000, at + oAfter * 60_000);
    if(wallMs >= lo && wallMs < hi)return {index:i, lo, hi};
  }
  return null;
}

// Every candidate for a wall time, one per distinct offset appearing in the
// zone. The mapping (wall - offset) is only real when that same offset is
// actually in effect at the proposed instant.
export function localToInstantCandidates(zone:Zone, wallMs:number):{
  kind:Kind; transition:number | null; gap:GapBounds | null; candidates:Candidate[];
}{
  const offsets = [...new Set(zone.segments.map(s => s.offset))];
  const proposed = offsets.map(offset => {
    const instant = wallMs - offset * 60_000;
    const effective = segmentAt(zone, instant);
    return {offset, instant, valid:effective.offset === offset, effective};
  });

  const window = findTransitionWindow(zone, wallMs);
  const validCount = proposed.filter(p => p.valid).length;
  let kind:Kind;
  let gap:GapBounds | null = null;
  let transition:number | null = null;

  // Classification follows the valid mappings: a skipped wall time has
  // none, a repeated wall time has two (or more). Counting instead of
  // relying on the transition window alone puts the exact boundary times
  // in the right place: the gap's first wall time is itself skipped, while
  // the overlap's first and last wall times each occur exactly once.
  if(validCount === 0 && window){
    const {index} = window;
    const at = zone.segments[index].at;
    const oBefore = zone.segments[index - 1].offset;
    const oAfter = zone.segments[index].offset;
    const lo = Math.min(at + oBefore * 60_000, at + oAfter * 60_000);
    const hi = Math.max(at + oBefore * 60_000, at + oAfter * 60_000);
    if(oAfter > oBefore){
      // Clocks jump forward: wall times inside [lo, hi) never happen.
      kind = 'gap';
      transition = at;
      gap = {
        transition:at, offsetBefore:oBefore, offsetAfter:oAfter,
        startLocal:lo, endLocal:hi,
        durationMinutes:oAfter - oBefore,
      };
    }else{
      kind = 'gap';
      transition = at;
    }
  }else if(validCount >= 2){
    kind = 'overlap';
    transition = window ? zone.segments[window.index].at : null;
  }else{
    kind = 'unique';
  }

  const candidates:Candidate[] = proposed.map(p => {
    const {offset, instant, valid, effective} = p;
    let role:CandidateRole = valid ? 'valid' : 'invalid';
    let basis:string;
    if(valid){
      basis = `subtract ${formatOffset(offset)}: instant ${formatInstant(instant)} lands in a ` +
        `segment where ${segmentBasis(zone, effective)}`;
    }else{
      basis = `subtract ${formatOffset(offset)}: would land at ${formatInstant(instant)}, but ` +
        `${segmentBasis(zone, effective)} there, so this wall time never occurs under ${formatOffset(offset)}`;
    }
    return {instant, offset, valid, role, basis};
  });

  if(kind === 'gap' && gap){
    // Both proposed instants are invalid but serve as boundaries. The one
    // computed with the larger (post-jump) offset lands just BEFORE the
    // transition and is the earlier boundary; the one using the pre-jump
    // offset lands just AFTER it and is the later boundary.
    const pair = candidates
      .filter(c => c.offset === gap!.offsetBefore || c.offset === gap!.offsetAfter)
      .sort((a,b) => a.instant - b.instant);
    if(pair[0]){
      pair[0].role = 'gapEarlier';
      pair[0].basis = `subtract ${formatOffset(pair[0].offset)}, the offset in force after ${formatInstant(gap.transition)}: ` +
        `the skipped wall time maps to ${formatInstant(pair[0].instant)} (before the transition), the earlier boundary; ` +
        `the gap runs from ${formatWall(gap.startLocal)} to ${formatWall(gap.endLocal)} local`;
    }
    if(pair[1]){
      pair[1].role = 'gapLater';
      pair[1].basis = `subtract ${formatOffset(pair[1].offset)}, the offset in force before ${formatInstant(gap.transition)}: ` +
        `the skipped wall time maps to ${formatInstant(pair[1].instant)} (after the transition), the later boundary; ` +
        `the gap runs from ${formatWall(gap.startLocal)} to ${formatWall(gap.endLocal)} local`;
    }
  }

  candidates.sort((a,b) => a.instant - b.instant || a.offset - b.offset);
  return {kind, transition, gap, candidates};
}

// Policies are resolved here on the server; clients never add or remove
// hours themselves. 'compatible' follows the Temporal convention: shift a
// gap forward (later instant) and take the first occurrence of an overlap
// (earlier instant).
export function applyPolicy(
  raw:{kind:Kind; transition:number | null; gap:GapBounds | null; candidates:Candidate[]},
  policy:Policy,
):ConversionResult['resolved'] | {rejected:true}{
  const valid = raw.candidates.filter(c => c.valid).sort((a,b) => a.instant - b.instant);
  if(raw.kind === 'unique'){
    const only = valid[0];
    return only ? {instant:only.instant, offset:only.offset} : {rejected:true as const};
  }
  if(policy === 'reject')return {rejected:true as const};
  if(raw.kind === 'overlap'){
    const pick = policy === 'later' ? valid[valid.length - 1] : valid[0];
    return pick ? {instant:pick.instant, offset:pick.offset} : {rejected:true as const};
  }
  // gap: policies pick one of the two boundary readings.
  const boundaries = raw.candidates
    .filter(c => c.role === 'gapEarlier' || c.role === 'gapLater')
    .sort((a,b) => a.instant - b.instant);
  const earlier = boundaries[0];
  const later = boundaries[boundaries.length - 1];
  const pick = policy === 'earlier' ? earlier : later; // compatible => later
  return pick ? {instant:pick.instant, offset:pick.offset} : {rejected:true as const};
}

export function instantToLocal(zone:Zone, instant:number):{epochMs:number; wall:string; offset:number}{
  const segment = segmentAt(zone, instant);
  const epochMs = instant + segment.offset * 60_000;
  return {epochMs, wall:formatWall(epochMs), offset:segment.offset};
}

export function resolveLocal(zone:Zone, wallMs:number, policy:Policy):ConversionResult{
  const raw = localToInstantCandidates(zone, wallMs);
  const decision = applyPolicy(raw, policy);
  const resolved = decision && !('rejected' in decision)
    ? {instant:decision.instant, offset:decision.offset} : null;
  let roundTrip:ConversionResult['roundTrip'] = null;
  if(raw.kind === 'unique' && resolved){
    const back = instantToLocal(zone, resolved.instant);
    const input = formatWall(wallMs);
    roundTrip = {input, output:back.wall, matches:back.epochMs === wallMs};
  }
  return {...raw, policy, resolved, rejected:resolved === null, roundTrip};
}

export function formatOffset(minutes:number):string{
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2,'0');
  const m = String(abs % 60).padStart(2,'0');
  return `${sign}${h}:${m}`;
}

export function formatInstant(ms:number):string{
  // Minute-resolution rendering for bundle instants; keep seconds if nonzero.
  return new Date(ms).toISOString()
    .replace(/:00\.000Z$/,'Z')
    .replace(/\.\d{3}Z$/,'Z');
}

export function formatWall(ms:number):string{
  return new Date(ms).toISOString().slice(0,16);
}
