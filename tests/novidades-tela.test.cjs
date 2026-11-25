const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {setup}=require('./novidades-persistence.test.cjs');

async function renderHtml(prepararPontos){
  const {db}=await setup();
  const r=db.criarRoteiro('ROTA');
  prepararPontos(db,r);
  const listContainer={innerHTML:''};
  const values={
    routeSelect:{value:String(r.id),selectedIndex:0,options:[{textContent:'ROTA'}]},
    listContainer,
  };
  const context=vm.createContext({console,window:{},document:{getElementById:id=>values[id],querySelectorAll:()=>[]}});
  const modules=new Map();
  async function synthetic(name,exportsObj){
    const m=new vm.SyntheticModule(Object.keys(exportsObj),function(){for(const [k,v]of Object.entries(exportsObj))this.setExport(k,v);},{context});
    await m.link(()=>{});await m.evaluate();modules.set(name,m);return m;
  }
  await synthetic('./database.js',{default:db,newUuid:()=>'test'});
  await synthetic('./google-sync.js',{sendChecklistToDrive:()=>{},getUltimaColeta:()=>{},getUltimasQuantidades:()=>{},getLastRoteirosDriveSyncLabel:()=>'',syncNovidadesRoteiro:async()=>({ok:true})});
  await synthetic('./dashboard-metrics.js',{operationalToday:()=>'',validCivilDate:()=>true});
  await synthetic('./coleta-sync.js',{startColetaSync:()=>{}});
  const nov=new vm.SourceTextModule(fs.readFileSync('roteiro-novidades.js','utf8'),{context});
  await nov.link(()=>{});await nov.evaluate();modules.set('./roteiro-novidades.js',nov);
  const source=fs.readFileSync('coleta-operation.js','utf8').replace(/init\(\);\s*$/,'')
    +'\nexport {renderList}; export function fixtureRender(c){currentClients=c;sessionData={};operationSaved=false;activeClientId=null;currentFilter="all";currentSort="ordem";}';
  const mod=new vm.SourceTextModule(source,{context});
  await mod.link(s=>modules.get(s));await mod.evaluate();
  mod.namespace.fixtureRender(db.getClientesByRoteiro(r.id));
  mod.namespace.renderList();
  return listContainer.innerHTML;
}

const hoje=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());

test('renderList marca NOVO so nos pontos novos e mostra o aviso com a contagem',async()=>{
  const html=await renderHtml((db,r)=>{
    db.criarPonto({idRota:'p1',cliente:'CLIENTE NOVO',roteiroId:r.id});
    db.criarPonto({idRota:'p2',cliente:'CLIENTE ANTIGO',roteiroId:r.id});
    db.addColeta({id_rota:'p2',data:hoje(),quantidade:1}); // encerra a novidade de p2
  });
  assert.match(html,/CLIENTE NOVO/);
  assert.match(html,/CLIENTE ANTIGO/);
  assert.equal((html.match(/novo-badge/g)||[]).length,1); // exatamente um ponto novo
  assert.match(html,/1 novo ponto/); // aviso singular de tituloNovidades
});

test('renderList sem novidades nao mostra badge nem aviso',async()=>{
  const html=await renderHtml((db,r)=>{
    db.criarPonto({idRota:'p1',cliente:'CLIENTE ANTIGO',roteiroId:r.id});
    db.addColeta({id_rota:'p1',data:hoje(),quantidade:1}); // sem novidades restantes
  });
  assert.match(html,/CLIENTE ANTIGO/);
  assert.doesNotMatch(html,/novo-badge/);
  assert.doesNotMatch(html,/novo ponto|novos pontos/);
});
