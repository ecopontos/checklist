const {test}=require('node:test');
const assert=require('node:assert/strict');
const {harness,Sheet}=require('./helpers/gas-mock.cjs');
const crypto=require('node:crypto');
function setup(){
  const h=harness(), props=new Map();
  const original=h.context.PropertiesService.getScriptProperties().getProperty;
  h.context.PropertiesService.getScriptProperties=()=>({getProperty:k=>props.get(k)??original(k),setProperty:(k,v)=>props.set(k,String(v))});
  h.context.Utilities={getUuid:()=>crypto.randomUUID(),parseCsv:(s,d)=>require('../vendor/papaparse.min.js').parse(s,{delimiter:d}).data,
    formatDate:(d,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(d)};
  h.csv='idRota;Roteiro;Cliente;Inativo\np0;A;Antigo;0';
  h.modified='2026-11-24T12:00:00Z';
  h.context.readRoteirosCsv_=()=>({ok:true,content:h.csv,modifiedTime:h.modified});
  h.query=(roteiro='A')=>JSON.parse(h.context.novidadesRoteiro_({token:h.token,roteiro}).value);
  h.add=(id='p1',r='A')=>{h.csv+=`\n${id};${r};Novo;0`; h.modified='2026-11-25T12:00:00Z';};
  return h;
}
test('baseline unica, inclusao por CSV e repeticao conservam identidade',()=>{
  const h=setup(); const first=h.query(); assert.equal(first.ok,true,first.error);
  assert.equal(first.inclusoes[0].baseline,true);
  h.add(); const next=h.query(); const i=next.inclusoes.find(i=>i.id_rota==='p1');
  assert.equal(i.baseline,false); assert.equal(i.incluido_em,'2026-11-25T12:00:00Z');
  assert.equal(h.query().inclusoes.find(i=>i.id_rota==='p1').inclusao_id,i.inclusao_id);
});
test('falha de fonte nao inicializa base e token invalido nao escreve',()=>{
  const h=setup(); h.context.readRoteirosCsv_=()=>({ok:false,error:'offline'});
  assert.equal(h.query().ok,false);
  assert.equal(JSON.parse(h.context.novidadesRoteiro_({token:'errado',roteiro:'A'}).value).ok,false);
  assert.equal(h.sheets.has('NovidadesRoteiros'),false);
});
test('intercorrencia encerra, retroativo e episodio diferente nao encerram',()=>{
  const h=setup(); h.query(); h.add(); const i=h.query().inclusoes.find(i=>i.id_rota==='p1');
  const sh=new Sheet(); h.sheets.set('Coletas',sh);
  sh.rows=[['ID Rota','Data','Cliente','Roteiro','Quantidade','Intercorrência','Sincronizado Em','Sync ID','Inclusao ID','Roteiro Chave'],
    ['p1','2026-11-24','Novo','A',1,'','2026-11-25T15:00:00Z','old',i.inclusao_id,'A'],
    ['p1','2026-11-25','Novo','A',1,'','2026-11-25T15:00:00Z','other','another','A']];
  assert.equal(h.query().inclusoes.find(i=>i.id_rota==='p1').atendimento,null);
  sh.rows.push(['p1','2026-11-25','Novo','A',0,'1','2026-11-25T15:00:00Z','valid',i.inclusao_id,'A']);
  assert.equal(h.query().inclusoes.find(i=>i.id_rota==='p1').atendimento.sync_id,'valid');
});
test('A-B-A cria episodio distinto sem reaproveitar coleta antiga',()=>{
  const h=setup(); h.query(); h.add(); const first=h.query().inclusoes.find(i=>i.id_rota==='p1');
  h.csv=h.csv.replace('p1;A;','p1;B;'); h.modified='2026-11-25T13:00:00Z'; h.query('B');
  h.csv=h.csv.replace('p1;B;','p1;A;'); h.modified='2026-11-25T14:00:00Z';
  const last=h.query().inclusoes.find(i=>i.id_rota==='p1'); assert.notEqual(first.inclusao_id,last.inclusao_id);
});
module.exports={setup};
