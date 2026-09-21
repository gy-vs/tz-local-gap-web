import {useEffect,useState} from 'react';
import {FlaskConical,Play,Save,Clock3,ArrowLeftRight,AlertTriangle,Layers,CheckCircle2} from 'lucide-react';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type TransitionView={at:string;offset:string;epochMs:number};
type ZoneView={name:string;base:string;transitions:TransitionView[]};
type Candidate={
  instant:string;instantEpochMs:number;offset:string;valid:boolean;
  role:'valid'|'gapEarlier'|'gapLater'|'invalid';localReading:string;basis:string;
};
type Conversion={
  bundle:string;revision:number;zone:string;policy:string;local:string;
  kind:'unique'|'gap'|'overlap';
  transition:string|null;transitionEpochMs:number|null;
  gap:{transition:string;offsetBefore:string;offsetAfter:string;startLocal:string;endLocal:string;durationMinutes:number}|null;
  candidates:Candidate[];
  resolved:{instant:string;instantEpochMs:number;offset:string}|null;
  rejected:boolean;
  roundTrip:{input:string;output:string;offset:string;matches:boolean}|null;
};

const POLICIES=[
  {value:'compatible',label:'Compatible（gap 推后 / overlap 取较早）'},
  {value:'earlier',label:'Earlier（取较早 instant）'},
  {value:'later',label:'Later（取较晚 instant）'},
  {value:'reject',label:'Reject（拒绝解析）'},
] as const;

const KIND_LABEL={unique:'unique（唯一）',gap:'gap（间隙）',overlap:'overlap（重叠）'} as const;

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [analysis,setAnalysis]=useState<unknown>(null);
  const [status,setStatus]=useState('Ready');
  const [zones,setZones]=useState<ZoneView[]>([]);
  const [zoneName,setZoneName]=useState('');
  const [local,setLocal]=useState('2024-03-31T02:30');
  const [policy,setPolicy]=useState<string>('compatible');
  const [conversion,setConversion]=useState<Conversion|null>(null);
  const [convertError,setConvertError]=useState<string|null>(null);

  useEffect(()=>{fetch('/api/bundles').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{
    setStatus('Loading');
    fetch('/api/bundles/'+selected).then(r=>r.json()).then((value:Row)=>{
      setRow(value);setDraft(value.content);setStatus('Loaded');
    });
  },[selected]);
  useEffect(()=>{
    fetch(`/api/bundles/${selected}/zones`).then(r=>r.json()).then(value=>{
      setZones(value.zones ?? []);
      setZoneName(prev => (value.zones ?? []).some((z:ZoneView)=>z.name===prev)
        ? prev : (value.zones?.[0]?.name ?? ''));
    });
  },[selected,row?.revision]);

  async function save(){
    if(!row)return;
    setStatus('Saving');
    const response=await fetch('/api/bundles/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});
    const value=await response.json();
    if(!response.ok){setStatus('Revision conflict');return}
    setRow(value);setStatus('Saved');
  }
  async function analyze(){
    if(!row)return;
    setStatus('Analyzing');
    const response=await fetch('/api/bundles/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});
    setAnalysis(await response.json());setStatus('Ready');
  }
  async function convert(){
    if(!zoneName)return;
    setConvertError(null);
    const params=new URLSearchParams({bundle:selected,zone:zoneName,local,policy});
    const response=await fetch('/api/convert?'+params);
    const value=await response.json();
    if(!response.ok){setConvertError(value.error==='invalid_local'?'本地时间格式应为 YYYY-MM-DDTHH:mm':JSON.stringify(value));setConversion(null);return}
    setConversion(value);
  }

  return <main className="shell">
    <header className="topbar"><FlaskConical size={20}/><strong>Timezone Data Studio</strong><small>Local workspace</small></header>
    <section className="workspace">
      <aside className="pane">
        <h2>Items</h2>
        <div className="list">{items.map(item=>
          <button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
      </aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>Save</button>
          <button onClick={analyze}><Play size={15}/>Analyze</button>
          <span>{status}</span>
        </div>
        <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/>
      </section>
      <aside className="pane inspector">
        <h2><Clock3 size={16}/> 本地时间 → UTC</h2>
        <div className="form">
          <label>Zone
            <select value={zoneName} onChange={e=>setZoneName(e.target.value)}>
              {zones.map(z=><option key={z.name} value={z.name}>{z.name}（base {z.base}，{z.transitions.length} 次过渡）</option>)}
            </select>
          </label>
          <label>本地时间
            <input value={local} onChange={e=>setLocal(e.target.value)} placeholder="2024-03-31T02:30"/>
          </label>
          <label>策略（服务端应用）
            <select value={policy} onChange={e=>setPolicy(e.target.value)}>
              {POLICIES.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <button className="primary convert-btn" onClick={convert}><ArrowLeftRight size={15}/>转换</button>
          {convertError && <div className="error"><AlertTriangle size={14}/>{convertError}</div>}
        </div>
        {conversion && <ResultView value={conversion}/>}
        <h2 className="inspect-title">Inspection</h2>
        <span className="pill">{selected}</span>
        <pre>{JSON.stringify(analysis??row,null,2)}</pre>
      </aside>
    </section>
  </main>;
}

function ResultView({value}:{value:Conversion}){
  const tone=value.kind==='unique'?'ok':value.kind==='gap'?'warn':'info';
  return <div className={`result ${tone}`}>
    <div className="result-head">
      {value.kind==='unique' ? <CheckCircle2 size={18}/> : value.kind==='gap' ? <AlertTriangle size={18}/> : <Layers size={18}/>}
      <strong>{KIND_LABEL[value.kind]}</strong>
      <span className="rev">rev {value.revision}</span>
    </div>

    {value.gap && <div className="bounds">
      <div>过渡点：<code>{value.gap.transition}</code>，offset {value.gap.offsetBefore} → {value.gap.offsetAfter}</div>
      <div>缺失区间（本地）：<code>{value.gap.startLocal}</code> 起，<code>{value.gap.endLocal}</code> 止（长 {value.gap.durationMinutes} 分钟）</div>
      <div className="hint">前边界 = 用过渡后 offset 映射到过渡前一瞬；后边界 = 用过渡前 offset 映射到过渡后一瞬</div>
    </div>}

    {value.kind==='overlap' && value.transition && <div className="bounds">
      <div>过渡点：<code>{value.transition}</code></div>
      <div className="hint">该本地时间在 offset 回拨期间出现两次，以下候选按 UTC instant 升序排列。</div>
    </div>}

    <ol className="candidates">
      {value.candidates.map((c,i)=>
        <li key={i} className={`cand ${c.valid?'valid':'invalid'} role-${c.role}`}>
          <div className="cand-line">
            <span className="badge">{c.role}</span>
            <code>{c.instant}</code>
            <span className="off">offset {c.offset}</span>
            <span className="reading">本地读作 {c.localReading}</span>
          </div>
          <div className="basis">{c.basis}</div>
        </li>)}
    </ol>

    <div className="resolved">
      {value.rejected
        ? <span className="rejected"><AlertTriangle size={14}/> 策略 reject：不返回任何 instant</span>
        : value.resolved && <>服务端解析结果：<code>{value.resolved.instant}</code><span className="off">（{value.resolved.offset}）</span></>}
    </div>

    {value.roundTrip && <div className={`roundtrip ${value.roundTrip.matches?'ok':'bad'}`}>
      {value.roundTrip.matches ? <CheckCircle2 size={14}/> : <AlertTriangle size={14}/>}
      往返验证：{value.roundTrip.input} → {value.resolved?.instant} → {value.roundTrip.output}
      {value.roundTrip.matches ? '，一致 ✓' : '，不一致 ✗'}
    </div>}
  </div>;
}
