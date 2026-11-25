const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {setup:gasSetup}=require('./gas-novidades.test.cjs');
async function device(gas){
  const storage=new Map([['app3_gas_url','https://gas.test/exec'],['app3_gas_route_token',gas.token]]);
  const h={offline:false,override:null};
  const context=vm.createContext({console,crypto:require('node:crypto').webcrypto,AbortController,setTimeout,clearTimeout,
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    initSqlJs:()=>require('../vendor/sql-wasm.js')({locateFile:f=>path.resolve('vendor',f)}),
    fetch:async(url,options)=>{if(h.offline) throw Error('offline');
      const body=JSON.parse(options.body); const result=h.override && body.action==='novidadesRoteiro' ? h.override :
        JSON.parse(gas.context.doPost({postData:{contents:options.body}}).value);
      return {ok:true,json:async()=>result};}
  });
  const mods=new Map();
  async function load(name){if(mods.has(name)) return mods.get(name);const m=new vm.SourceTextModule(fs.readFileSync(name,'utf8'),{context});mods.set(name,m);
    await m.link(s=>load(s.replace('./','')));await m.evaluate();return m;}
  h.db=(await load('database.js')).namespace.default; await h.db.init();
  h.sync=(await load('google-sync.js')).namespace; return h;
}
test('dois aparelhos e aparelho novo convergem apos retorno salvo e sincronizado',async()=>{
  const gas=gasSetup(); gas.query(); const a=await device(gas),b=await device(gas);
  const r=a.db.criarRoteiro('A'); a.db.criarPonto({idRota:'p1',cliente:'Padaria',roteiroId:r.id});
  assert.equal((await a.sync.syncNovidadesRoteiro(a.db,r.id)).ok,true);
  await b.sync.syncCadastro(b.db); const rb=b.db.getRoteiros()[0];
  assert.equal((await b.sync.syncNovidadesRoteiro(b.db,rb.id)).ok,true);
  assert.equal(b.db.getNovidadesRoteiro(rb.id).length,1);
  a.db.addColeta({id_rota:'p1',data:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),quantidade:0,intercorrencia:'1'});
  assert.equal(a.db.getNovidadesRoteiro(r.id).length,0);
  assert.equal((await a.sync.syncPendingColetas(a.db)).ok,true);
  assert.equal((await b.sync.syncNovidadesRoteiro(b.db,rb.id)).ok,true);
  assert.equal(b.db.getNovidadesRoteiro(rb.id).length,0);
  const c=await device(gas); await c.sync.syncCadastro(c.db);const rc=c.db.getRoteiros()[0];
  await c.sync.syncNovidadesRoteiro(c.db,rc.id); assert.equal(c.db.getNovidadesRoteiro(rc.id).length,0);
});
test('falha remota e GAS antigo conservam novidade local',async()=>{
  const gas=gasSetup();gas.query();const a=await device(gas),r=a.db.criarRoteiro('A');
  a.db.criarPonto({idRota:'p1',cliente:'Padaria',roteiroId:r.id});
  await a.sync.syncNovidadesRoteiro(a.db,r.id); const id=a.db.getInclusaoAtual('p1').inclusao_id;
  a.offline=true; assert.equal((await a.sync.syncNovidadesRoteiro(a.db,r.id)).ok,false);
  a.offline=false;a.override={ok:true,apiVersion:16};assert.equal((await a.sync.syncNovidadesRoteiro(a.db,r.id)).ok,false);
  assert.equal(a.db.getInclusaoAtual('p1').inclusao_id,id);assert.equal(a.db.getNovidadesRoteiro(r.id).length,1);
});
module.exports={device};
test('resposta de outro roteiro nao substitui estado conhecido',async()=>{
  const gas=gasSetup();gas.query();const a=await device(gas),r=a.db.criarRoteiro('A');
  a.db.criarPonto({idRota:'p1',cliente:'Padaria',roteiroId:r.id});
  await a.sync.syncNovidadesRoteiro(a.db,r.id);
  a.override={ok:true,apiVersion:17,novidadesRoteiros:true,roteiro_chave:'B',rev:999,inclusoes:[]};
  assert.equal((await a.sync.syncNovidadesRoteiro(a.db,r.id)).ok,false);
  assert.equal(a.db.getNovidadesRoteiro(r.id).length,1);
});
