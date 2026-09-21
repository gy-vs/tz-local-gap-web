import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  applyPolicy, findZone, formatInstant, formatOffset, formatWall,
  instantToLocal, localToInstantCandidates, parseBundle, parseWall,
  POLICIES, type Policy,
} from './tz.js';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};

const ALPHA = `# Primary timezone bundle
zone Alpha/OneHour base +01:00
2024-03-31T01:00Z +02:00
2024-10-27T01:00Z +01:00
2025-03-30T01:00Z +02:00
2025-10-26T01:00Z +01:00
zone Alpha/Fixed base +00:00
`;

const BETA = `# Secondary timezone bundle: half-hour shifts and negative DST
zone Beta/HalfHour base +10:30
2024-10-05T15:30Z +11:00
2025-04-05T15:00Z +10:30
zone Beta/Negative base -03:00
2024-10-06T04:00Z -02:00
2025-04-06T03:00Z -03:00
`;

const rows: RecordRow[] = [
  {id:'alpha',name:'Primary timezone bundles',revision:3,content:ALPHA,updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary timezone bundles',revision:5,content:BETA,updatedAt:new Date(1000).toISOString()},
];

function serializeCandidate(c:{instant:number;offset:number;valid:boolean;role:string;basis:string}){
  return {
    instant:formatInstant(c.instant),
    instantEpochMs:c.instant,
    offset:formatOffset(c.offset),
    valid:c.valid,
    role:c.role,
    localReading:formatWall(c.instant + c.offset * 60_000),
    basis:c.basis,
  };
}

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:'timezone-bundle',count:rows.length}));
  app.get('/api/bundles',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/bundles/:id',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    res.set('ETag',String(row.revision)).json(row);
  });
  app.put('/api/bundles/:id',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});
    row.content=String(req.body.content??'');
    row.revision+=1;
    row.updatedAt=new Date().toISOString();
    res.json(row);
  });
  app.post('/api/bundles/:id/analyze',async(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    await new Promise(resolve=>setTimeout(resolve,row.id==='alpha'?100:20));
    const content=String(req.body.content??row.content);
    const parsed=parseBundle(content);
    res.json({
      id:row.id,revision:row.revision,
      lines:content.split(/\r?\n/).length,
      zones:parsed.zones.map(z=>({
        name:z.name,
        base:formatOffset(z.segments[0].offset),
        transitions:z.segments.slice(1).map(s=>({at:formatInstant(s.at),offset:formatOffset(s.offset)})),
      })),
      diagnostics:parsed.errors,
    });
  });

  app.get('/api/bundles/:id/zones',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const parsed=parseBundle(row.content);
    res.set('ETag',String(row.revision)).json({
      revision:row.revision,
      zones:parsed.zones.map(z=>({
        name:z.name,
        base:formatOffset(z.segments[0].offset),
        transitions:z.segments.slice(1).map(s=>({at:formatInstant(s.at),offset:formatOffset(s.offset),epochMs:s.at})),
      })),
      parseErrors:parsed.errors,
    });
  });

  // Convert a wall time in a bundle zone to UTC candidates.
  // Query: zone, local (YYYY-MM-DDTHH:mm[:ss]), policy
  app.get('/api/convert',(req,res)=>{
    const bundleId=String(req.query.bundle??'');
    const zoneName=String(req.query.zone??'');
    const row=rows.find(value=>value.id===bundleId);
    if(!row)return res.status(404).json({error:'bundle_not_found'});
    const parsed=parseBundle(row.content);
    const zone=findZone(parsed,zoneName);
    if(!zone)return res.status(404).json({error:'zone_not_found',available:parsed.zones.map(z=>z.name),parseErrors:parsed.errors});
    const wallMs=parseWall(String(req.query.local??''));
    if(wallMs===null)return res.status(400).json({error:'invalid_local',expected:'YYYY-MM-DDTHH:mm'});
    const policy=(POLICIES as readonly string[]).includes(String(req.query.policy))
      ? String(req.query.policy) as Policy : 'compatible';
    const raw=localToInstantCandidates(zone,wallMs);
    const decision=applyPolicy(raw,policy);
    const resolved=decision && !('rejected' in decision)
      ? {instant:decision.instant, offset:decision.offset} : null;
    const rejected=resolved===null;
    let roundTrip=null;
    if(raw.kind==='unique'&&resolved){
      const back=instantToLocal(zone,resolved.instant);
      roundTrip={input:formatWall(wallMs),output:back.wall,offset:formatOffset(back.offset),matches:back.epochMs===wallMs};
    }
    res.set('ETag',`${row.revision}`).json({
      bundle:row.id,revision:row.revision,zone:zone.name,policy,
      local:formatWall(wallMs),
      kind:raw.kind,
      transition:raw.transition===null?null:formatInstant(raw.transition),
      transitionEpochMs:raw.transition,
      gap:raw.gap?{
        transition:formatInstant(raw.gap.transition),
        offsetBefore:formatOffset(raw.gap.offsetBefore),
        offsetAfter:formatOffset(raw.gap.offsetAfter),
        startLocal:formatWall(raw.gap.startLocal),
        endLocal:formatWall(raw.gap.endLocal),
        durationMinutes:raw.gap.durationMinutes,
      }:null,
      candidates:raw.candidates.map(serializeCandidate),
      resolved:resolved?{instant:formatInstant(resolved.instant),instantEpochMs:resolved.instant,offset:formatOffset(resolved.offset)}:null,
      rejected,
      roundTrip,
    });
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
