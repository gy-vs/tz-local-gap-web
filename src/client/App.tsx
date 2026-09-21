import {useCallback, useEffect, useState} from 'react';
import {FlaskConical, Play, Save} from 'lucide-react';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

type Policy='compatible'|'earlier'|'later'|'reject';
const POLICIES:{value:Policy;label:string;hint:string}[]=[
  {value:'compatible',label:'兼容 compatible',hint:'gap 取较晚 instant，overlap 取第一次出现'},
  {value:'earlier',label:'较早 earlier',hint:'gap/overlap 都取较早 instant'},
  {value:'later',label:'较晚 later',hint:'gap/overlap 都取较晚 instant'},
  {value:'reject',label:'拒绝 reject',hint:'非 unique 一律拒绝，不给出 instant'},
];

type ZoneSummary={name:string;baseOffsetLabel:string;transitionCount:number;transitions:{instant:string;offsetLabel:string}[]};
type Diagnostic={line:number;level:'error'|'warning';code:string;message:string};

type Candidate={
  ordinal:number;instant:string;offsetLabel:string;side:'before'|'after'|'between';
  occurrence:'only'|'first'|'second'|'extra';exists:boolean;wallShiftSeconds:number;basis:string;
};
type GapBoundary={local:string;instant:string;offsetLabel:string;real:boolean};
type TransitionInfo={instant:string;offsetBeforeLabel:string;offsetAfterLabel:string};
type ResolvedChoice={instant:string;offsetLabel:string;side:string;note:string;roundTripLocal:string;roundTripOk:boolean};
type ResolveResult={
  kind:'unique'|'gap'|'overlap';zone:string;local:string;policy:Policy;
  candidates:Candidate[];
  gap?:{shiftSeconds:number;before:GapBoundary;after:GapBoundary};
  transition:TransitionInfo|null;
  resolved:ResolvedChoice|null;
};

const KIND_TEXT={unique:'唯一 unique',gap:'间隙 gap（时间不存在）',overlap:'重叠 overlap（时间出现多次）'} as const;
const SIDE_TEXT={before:'过渡前',after:'过渡后',between:'过渡之间'} as const;
const OCC_TEXT={only:'唯一一次',first:'第一次出现',second:'第二次出现',extra:'更多次出现'} as const;

function occText(c:Candidate):string{
  if(!c.exists)return c.ordinal===1?'较早插值':'较晚插值';
  return OCC_TEXT[c.occurrence];
}

function shiftText(seconds:number):string{
  if(seconds===0)return '无偏移修正';
  const abs=Math.abs(seconds);
  const h=Math.floor(abs/3600),m=Math.floor(abs%3600/60),s=abs%60;
  const parts=[h&&`${h} 小时`,m&&`${m} 分钟`,s&&`${s} 秒`].filter(Boolean).join('');
  return `${seconds>0?'前拨':'回拨'} ${parts}`;
}

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [analysis,setAnalysis]=useState<{diagnostics:Diagnostic[];zones:ZoneSummary[];lines:number}|null>(null);
  const [status,setStatus]=useState('就绪');

  const [zones,setZones]=useState<ZoneSummary[]>([]);
  const [zone,setZone]=useState('');
  const [local,setLocal]=useState('2024-03-10T02:30:00');
  const [policy,setPolicy]=useState<Policy>('compatible');
  const [result,setResult]=useState<{revision:number;result:ResolveResult}|null>(null);
  const [resolveError,setResolveError]=useState<string|null>(null);

  useEffect(()=>{fetch('/api/bundles').then(r=>r.json()).then(setItems)},[]);

  useEffect(()=>{
    setStatus('加载中');setResult(null);setAnalysis(null);setResolveError(null);
    fetch('/api/bundles/'+selected).then(r=>r.json()).then((value:Row)=>{
      setRow(value);setDraft(value.content);setStatus('已加载');
    });
    fetch(`/api/bundles/${selected}/zones`).then(r=>r.json()).then((v:{zones:ZoneSummary[]})=>{
      setZones(v.zones??[]);setZone(v.zones?.[0]?.name??'');
    });
  },[selected]);

  async function save(){
    if(!row)return;
    setStatus('保存中');
    const response=await fetch('/api/bundles/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});
    const value=await response.json();
    if(response.status===409){setStatus('Revision 冲突：已被其他会话更新');return}
    if(!response.ok){setStatus(`保存被拒：${value.error}`);return}
    setRow(value);setStatus(`已保存，revision ${value.revision}`);
    const z=await fetch(`/api/bundles/${selected}/zones`).then(r=>r.json());
    setZones(z.zones??[]);
    setResult(null);
  }

  async function analyze(){
    if(!row)return;
    setStatus('分析中');
    const response=await fetch('/api/bundles/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});
    setAnalysis(await response.json());setStatus('就绪');
  }

  const resolve=useCallback(async()=>{
    setResolveError(null);setResult(null);
    const response=await fetch(`/api/bundles/${selected}/resolve`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({zone,local:local.replace('T',' '),policy}),
    });
    const value=await response.json();
    if(!response.ok){setResolveError(value.message??value.error??'解析失败');return}
    setResult(value);
  },[selected,zone,local,policy]);

  return <main className="shell">
    <header className="topbar"><FlaskConical size={20}/><strong>时区数据工作台</strong><small>本地时间 → UTC 候选解析</small></header>
    <section className="workspace">
      <aside className="pane">
        <h2>Bundles</h2>
        <div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>
          {item.name}<br/><small>Revision {item.revision}</small>
        </button>)}</div>
      </aside>

      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>保存（revision 递增）</button>
          <button onClick={analyze}><Play size={15}/>分析 bundle</button>
          <span>{status}</span>
        </div>
        <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/>
        {analysis&&<div className="analysis">
          <h3>Bundle 分析（revision {row?.revision}，{analysis.lines} 行）</h3>
          {analysis.diagnostics.length===0&&<p className="ok">无诊断问题</p>}
          {analysis.diagnostics.map((d,i)=><p key={i} className={`diag ${d.level}`}>第 {d.line} 行 · {d.level} · {d.message}</p>)}
          <ul className="zone-list">{analysis.zones.map(z=><li key={z.name}><code>{z.name}</code> 基础 {z.baseOffsetLabel}，{z.transitionCount} 个过渡</li>)}</ul>
        </div>}
      </section>

      <aside className="pane result-pane">
        <h2>本地时间转 UTC</h2>
        <label className="field">Zone
          <select value={zone} onChange={e=>setZone(e.target.value)}>
            {zones.map(z=><option key={z.name} value={z.name}>{z.name}（{z.baseOffsetLabel}，{z.transitionCount} 过渡）</option>)}
          </select>
        </label>
        <label className="field">本地墙钟时间
          <input type="datetime-local" step={1} value={local} onChange={e=>setLocal(e.target.value)}/>
        </label>
        <fieldset className="policy">
          <legend>消歧策略（服务端统一应用，前端不加减小时）</legend>
          {POLICIES.map(p=><label key={p.value} className={policy===p.value?'chosen':''}>
            <input type="radio" name="policy" checked={policy===p.value} onChange={()=>setPolicy(p.value)}/>
            <span>{p.label}<small>{p.hint}</small></span>
          </label>)}
        </fieldset>
        <button className="primary resolve-btn" onClick={resolve}>解析候选</button>
        {resolveError&&<p className="diag error">{resolveError}</p>}
        {result&&<ResolveView data={result.result} bundleRevision={result.revision}/>}
      </aside>
    </section>
  </main>;
}

function ResolveView({data,bundleRevision}:{data:ResolveResult;bundleRevision:number}){
  return <div className="resolve">
    <div className={`kind-badge ${data.kind}`}>{KIND_TEXT[data.kind]}</div>
    <p className="meta">zone <code>{data.zone}</code> · 本地 <code>{data.local}</code> · bundle revision {bundleRevision}</p>

    {data.transition&&<div className="card transition">
      <h3>相关过渡</h3>
      <p>过渡瞬间（UTC）：<code>{data.transition.instant}</code></p>
      <p>偏移：<code>{data.transition.offsetBeforeLabel}</code> → <code>{data.transition.offsetAfterLabel}</code></p>
    </div>}

    {data.kind==='gap'&&data.gap&&<div className="card gap-box">
      <h3>间隙边界（该时段本地时间不存在）</h3>
      <Boundary label="前边界（旧读数最后一刻）" b={data.gap.before}/>
      <Boundary label="后边界（新读数第一刻）" b={data.gap.after}/>
      <p className="dim">两侧墙钟对应的是同一个 UTC 瞬间；时钟在该瞬间直接跳过中间的本地时间。</p>
    </div>}

    <h3>候选（按 instant 升序，共 {data.candidates.length} 个）</h3>
    <div className="candidates">
      {data.candidates.map(c=><div key={c.ordinal} className={`card candidate ${c.exists?'':'virtual'}`}>
        <div className="cand-head">
          <span className="ordinal">#{c.ordinal}</span>
          <strong>{c.instant}</strong>
          <span className={`tag ${c.exists?'real':'fake'}`}>{c.exists?'真实存在':'插值（不存在）'}</span>
        </div>
        <p className="cand-tags">偏移 <code>{c.offsetLabel}</code> · {SIDE_TEXT[c.side]} · {occText(c)} · {shiftText(c.wallShiftSeconds)}</p>
        <p className="basis">依据：{c.basis}</p>
      </div>)}
    </div>

    <div className="card chosen">
      <h3>策略「{data.policy}」的服务端裁决</h3>
      {data.resolved?<>
        <p>选定 instant：<strong>{data.resolved.instant}</strong>（偏移 {data.resolved.offsetLabel}，{SIDE_TEXT[data.resolved.side as keyof typeof SIDE_TEXT]??data.resolved.side}）</p>
        <p>{data.resolved.note}</p>
        <RoundTrip local={data.local} choice={data.resolved}/>
      </>:<p className="diag error">reject：本地时间不唯一，已拒绝返回 instant。</p>}
    </div>
  </div>;
}

function Boundary({label,b}:{label:string;b:GapBoundary}){
  return <div className="boundary">
    <span>{label}</span>
    <p>本地 <code>{b.local}</code> ⟷ UTC <code>{b.instant}</code>（偏移 {b.offsetLabel}）</p>
  </div>;
}

function RoundTrip({local,choice}:{local:string;choice:ResolvedChoice}){
  return <p className={`roundtrip ${choice.roundTripOk?'ok':'bad'}`}>
    往返验证：instant + 选定偏移 = <code>{choice.roundTripLocal}</code>
    {choice.roundTripOk
      ?<> ✓ 与输入 <code>{local}</code> 一致</>
      :<> ≠ 输入 <code>{local}</code>：gap 插值往返必然落回不存在的墙钟时间，属预期</>}
  </p>;
}
