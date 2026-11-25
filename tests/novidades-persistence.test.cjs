const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
async function setup(saved) {
  const storage = new Map(saved ? [['app3_db', saved]] : []);
  const context = vm.createContext({ console, crypto: require('node:crypto').webcrypto,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: f => path.resolve('vendor', f) }) });
  const mod = new vm.SourceTextModule(fs.readFileSync('database.js','utf8'), { context });
  await mod.link(() => {}); await mod.evaluate(); const db = mod.namespace.default; await db.init();
  return { db, storage };
}
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo' }).format(new Date());
function create(db) { const r = db.criarRoteiro('A'); db.criarPonto({ idRota:'p1', cliente:'Padaria', roteiroId:r.id }); return r; }
test('base antiga nao e novidade; criacao persiste e edicao nao recria episodio', async () => {
  const {db,storage} = await setup();
  db.importRoteirosRows([{ idRota:'old',Cliente:'Antigo',Roteiro:'A',Ordem:1,Inativo:0 }]);
  assert.equal(db.getNovidadesRoteiro(db.getRoteiros()[0].id).length,0);
  const r = db.getRoteiros()[0]; db.criarPonto({ idRota:'p1', cliente:'Padaria', roteiroId:r.id });
  const id = db.getInclusaoAtual('p1').inclusao_id;
  db.upsertCliente({idRota:'p1',Cliente:'Outro nome',logradouro:'',CEP:'',roteiro_id:r.id,Ordem:5,ativo:true},{origemApp:true});
  assert.equal(db.getInclusaoAtual('p1').inclusao_id,id);
  const reloaded = await setup(storage.get('app3_db'));
  assert.equal(reloaded.db.getNovidadesRoteiro(r.id).length,1);
});
for (const [qty,issue,data,want] of [[1,'',day(),0],[0,'1',day(),0],[0,'  ',day(),1],[1,'','2020-01-01',1]]) {
  test(`retorno ${qty}/${JSON.stringify(issue)}/${data} -> ${want} novidades`,async()=>{
    const {db}=await setup(); const r=create(db);
    db.addColeta({id_rota:'p1',data,quantidade:qty,intercorrencia:issue});
    assert.equal(db.getNovidadesRoteiro(r.id).length,want);
    assert.equal(db.getUnsyncedColetas()[0].inclusao_id,db.getInclusaoAtual('p1').inclusao_id);
  });
}
test('A-B-A no mesmo dia nao reutiliza evidencia do episodio anterior',async()=>{
  const {db}=await setup(); const a=create(db), b=db.criarRoteiro('B');
  db.addColeta({id_rota:'p1',data:day(),quantidade:1}); const first=db.getInclusaoAtual('p1').inclusao_id;
  for (const r of [b,a]) db.upsertCliente({idRota:'p1',Cliente:'Padaria',logradouro:'',CEP:'',roteiro_id:r.id,Ordem:1,ativo:true},{origemApp:true});
  assert.notEqual(db.getInclusaoAtual('p1').inclusao_id,first);
  assert.equal(db.getNovidadesRoteiro(a.id).length,1);
});
module.exports = { setup };
