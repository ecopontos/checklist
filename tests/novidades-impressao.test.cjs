const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {setup}=require('./novidades-persistence.test.cjs');
async function load(){
  const jspdf=require('../vendor/jspdf.umd.min.js');
  const context=vm.createContext({console,jspdf});
  vm.runInContext(fs.readFileSync('vendor/jspdf.plugin.autotable.min.js','utf8'),context);
  const mod=new vm.SourceTextModule(fs.readFileSync('roteiro-novidades.js','utf8'),{context});
  await mod.link(()=>{});await mod.evaluate();return {ns:mod.namespace,jsPDF:jspdf.jsPDF};
}
test('resumo PDF real pagina nomes longos e preserva area inferior',async()=>{
  const {ns,jsPDF}=await load();const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const novos=Array.from({length:100},(_,i)=>({id_rota:String(i),ordem:i+1,cliente:'Associação de moradores <Teste> & Açores — nome longo '.repeat(3)}));
  const y=ns.desenharResumoNovidades(doc,novos,{startY:36,bottomReserve:42});
  assert.ok(doc.getNumberOfPages()>1);assert.ok(y<doc.internal.pageSize.getHeight()-42);
  assert.match(doc.output(),/100 novos pontos/);
  fs.mkdirSync('.superpowers/sdd/2026-11-25-novas-inclusoes-roteiros',{recursive:true});
  fs.writeFileSync('.superpowers/sdd/2026-11-25-novas-inclusoes-roteiros/resumo-fixture.pdf',Buffer.from(doc.output('arraybuffer')));
});
test('sem novidades nao ocupa espaco; resumo singular e selecao mantem ordem',async()=>{
  const {ns,jsPDF}=await load();const doc=new jsPDF();
  assert.equal(ns.desenharResumoNovidades(doc,[],{startY:36,bottomReserve:42}),36);
  const clientes=[{id_rota:'b',cliente:'B',ordem:2,ativo:1},{id_rota:'a',cliente:'A',ordem:1,ativo:1},{id_rota:'off',ativo:0}];
  const rows=ns.listarNovidades({getNovidadesRoteiro:()=>[{id_rota:'a'},{id_rota:'b'},{id_rota:'off'}]},1,clientes);
  assert.deepEqual(Array.from(rows,r=>r.id_rota),['b','a']);
  ns.desenharResumoNovidades(doc,[rows[0]],{startY:36,bottomReserve:42});
  assert.match(doc.output(),/1 novo ponto/);
});
test('resumo HTML trata nome como texto e desaparece quando nao ha novidades',async()=>{
  const {ns}=await load();
  const doc={createElement:tag=>({tag,textContent:'',children:[],appendChild(n){this.children.push(n);}})};
  const container={ownerDocument:doc,hidden:false,children:[],replaceChildren(){this.children=[];},appendChild(n){this.children.push(n);}};
  ns.renderResumoNovidades(container,[{ordem:3,cliente:'<img src=x onerror=alert(1)>'}]);
  assert.equal(container.hidden,false);
  assert.equal(container.children[1].children[0].textContent,'3 — <img src=x onerror=alert(1)>');
  ns.renderResumoNovidades(container,[]);assert.equal(container.hidden,true);assert.equal(container.children.length,0);
});

test('controlador gera NOVO em reimpressoes ate retorno persistido',async()=>{
  const {db}=await setup();
  const r=db.criarRoteiro('ROTA');db.criarPonto({idRota:'p1',cliente:'CLIENTE NOVO',roteiroId:r.id});
  const {jsPDF}=await load();
  const values={routeSelect:{value:String(r.id),selectedIndex:0,options:[{textContent:'ROTA'}]},proxData:{value:'2026-11-26'},tipoResiduo:{value:'Vidros'},checklistMotorista:{value:''},checklistVeiculo:{value:''}};
  const context=vm.createContext({console,window:{jspdf:{jsPDF}},document:{getElementById:id=>values[id]}});
  const modules=new Map();
  async function synthetic(name,values){const m=new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});await m.link(()=>{});await m.evaluate();modules.set(name,m);return m;}
  await synthetic('./database.js',{default:db,newUuid:()=> 'test'});
  await synthetic('./google-sync.js',{sendChecklistToDrive:()=>{},getUltimaColeta:()=>{},getUltimasQuantidades:()=>{},getLastRoteirosDriveSyncLabel:()=>'',syncNovidadesRoteiro:async()=>({ok:true})});
  await synthetic('./dashboard-metrics.js',{operationalToday:()=>'',validCivilDate:()=>true});
  await synthetic('./coleta-sync.js',{startColetaSync:()=>{}});
  const nov=new vm.SourceTextModule(fs.readFileSync('roteiro-novidades.js','utf8'),{context});await nov.link(()=>{});await nov.evaluate();modules.set('./roteiro-novidades.js',nov);
  const source=fs.readFileSync('coleta-operation.js','utf8').replace(/init\(\);\s*$/,'')+'\nexport {buildChecklistDoc}; export function fixture(c){currentClients=c;sessionData={p1:{qty:1,issue:"1"}};}';
  const mod=new vm.SourceTextModule(source,{context});await mod.link(s=>modules.get(s));await mod.evaluate();mod.namespace.fixture(db.getClientesByRoteiro(r.id));
  for(let i=0;i<2;i++) {
    const pdf=mod.namespace.buildChecklistDoc().doc;
    assert.match(pdf.output(),/NOVO - CLIENTE NOVO/);
    if(i===0) fs.writeFileSync('.superpowers/sdd/2026-11-25-novas-inclusoes-roteiros/checklist-fixture.pdf',Buffer.from(pdf.output('arraybuffer')));
  }
  db.addColeta({id_rota:'p1',data:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),quantidade:1});
  assert.doesNotMatch(mod.namespace.buildChecklistDoc().doc.output(),/NOVO - CLIENTE NOVO/);
});
