import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  parseBundle, hasErrors, resolveLocal, findZone, zoneSummary,
  POLICIES, type DisambiguationPolicy, type ResolveResult,
} from './tz';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};

const DEFAULT_ALPHA = [
  '# 时区 bundle：zone 声明基础偏移，at 给出 UTC 瞬间的偏移切换',
  'zone Demo/East -05:00',
  '# 连续历史过渡：2023 与 2024 各有一次春季前拨 / 秋季回拨（整小时）',
  'at 2023-03-12T07:00:00Z -04:00',
  'at 2023-11-05T06:00:00Z -05:00',
  'at 2024-03-10T07:00:00Z -04:00',
  'at 2024-11-03T06:00:00Z -05:00',
  'zone Demo/Half +10:30',
  '# 非整小时：半小时偏移（类 Lord Howe），春季半小时间隙、秋季半小时重叠',
  'at 2024-10-06T16:00:00Z +11:00',
  'at 2025-04-05T16:00:00Z +10:30',
  'zone Demo/Neg +01:00',
  '# 负 DST：夏季偏移反而减小（类爱尔兰），春季回拨=重叠、秋季前拨=间隙',
  'at 2024-03-31T01:00:00Z +00:00',
  'at 2024-10-27T01:00:00Z +01:00',
  'zone Demo/Fixed +05:30',
  '# 无任何过渡：全年固定偏移',
].join('\n');

const DEFAULT_BETA = [
  'zone Demo/Beta +00:00',
  'at 2024-06-01T00:00:00Z +02:00',
  'at 2025-01-01T00:00:00Z +01:00',
  '# 故意乱序：2024-06 之前还需要一个更早的过渡，触发 warning，服务端自动排序',
  'at 2024-01-01T00:00:00Z +01:00',
].join('\n');

const rows: RecordRow[] = [
  {id:'alpha',name:'Primary timezone bundles',revision:3,content:DEFAULT_ALPHA,updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary timezone bundles',revision:5,content:DEFAULT_BETA,updatedAt:new Date(1000).toISOString()},
];

/** 重置内存数据到出厂状态，主要供测试隔离使用。 */
export function resetRows(){
  rows.splice(0,rows.length,
    {id:'alpha',name:'Primary timezone bundles',revision:3,content:DEFAULT_ALPHA,updatedAt:new Date(0).toISOString()},
    {id:'beta',name:'Secondary timezone bundles',revision:5,content:DEFAULT_BETA,updatedAt:new Date(1000).toISOString()},
  );
}

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"timezone-bundle",count:rows.length,policies:POLICIES}));
  app.get('/api/bundles',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/bundles/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/bundles/:id',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});
    const content=String(req.body.content??'');
    const doc=parseBundle(content);
    if(hasErrors(doc))return res.status(422).json({error:'invalid_bundle',diagnostics:doc.diagnostics});
    row.content=content;row.revision+=1;row.updatedAt=new Date().toISOString();
    res.json(row);
  });
  app.post('/api/bundles/:id/analyze',async(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?20:10));
    const content=String(req.body.content??row.content);
    const doc=parseBundle(content);
    res.json({id:row.id,revision:row.revision,lines:content.split(/\r?\n/).length,diagnostics:doc.diagnostics,zones:doc.zones.map(zoneSummary)});
  });

  // 列出 bundle 内全部 zone 及其过渡（供前端下拉，前端不自行解析）
  app.get('/api/bundles/:id/zones',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const doc=parseBundle(row.content);
    if(hasErrors(doc))return res.status(422).json({error:'invalid_bundle',diagnostics:doc.diagnostics});
    res.json({revision:row.revision,zones:doc.zones.map(zoneSummary)});
  });

  // 本地墙钟时间 -> UTC 候选。所有消歧策略在服务端统一执行。
  app.post('/api/bundles/:id/resolve',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const zoneName=String(req.body?.zone??'');
    const local=String(req.body?.local??'');
    const policy=String(req.body?.policy??'compatible') as DisambiguationPolicy;
    if(!POLICIES.includes(policy))return res.status(400).json({error:'invalid_policy',policies:POLICIES});
    const doc=parseBundle(row.content);
    if(hasErrors(doc))return res.status(422).json({error:'invalid_bundle',diagnostics:doc.diagnostics});
    const zone=findZone(doc,zoneName);
    if(!zone)return res.status(400).json({error:'unknown_zone',zone:zoneName,zones:doc.zones.map(z=>z.name)});
    let result: ResolveResult;
    try{result=resolveLocal(zone,local,policy);}
    catch(err){return res.status(400).json({error:'invalid_local',message:(err as Error).message});}
    res.json({revision:row.revision,result});
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
