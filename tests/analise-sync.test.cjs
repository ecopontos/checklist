const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('botao manual usa fila compartilhada e conserva identidade legada', async () => {
  const html = fs.readFileSync('analise.html','utf8');
  const moduleScript = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].at(-1)[1];
  assert.match(moduleScript, /import \{ syncPendingColetas \}/);
  assert.doesNotMatch(moduleScript, /pushColetas|crypto\.randomUUID/);
  let calls = 0; const alerts = [];
  const context = vm.createContext({ console, Papa:{}, XLSX:{ SSF:{ parse_date_code:value => value === 46000 ? {y:2025,m:12,d:9} : null } }, FileReader:function(){},
    alert: message => alerts.push(message),
    document: { getElementById: () => ({ files:[], appendChild(){}, innerHTML:'', onchange:null, onclick:null }) },
    db: { init:async()=>{}, getUnsyncedColetas:()=>[{ id:1, sync_id:null }], db:{ exec:()=>[] } },
    syncPendingColetas: async db => { calls++; assert.equal(db.getUnsyncedColetas()[0].sync_id, null); return {ok:false,error:'offline',pending:1}; }
  });
  const source = moduleScript.replace(/^\s*import .*;$/gm,'').replace(/\n\s*init\(\);\s*$/,'');
  vm.runInContext(source, context); vm.runInContext('renderStats=()=>{}',context);
  assert.equal(vm.runInContext("parseHistoryQuantity('2,0')",context),2);
  assert.equal(vm.runInContext("parseHistoryQuantity('1.5')",context),null);
  assert.equal(vm.runInContext("normalizeHistoryDate('31/03/2026')",context),'2026-03-31');
  assert.equal(vm.runInContext("normalizeHistoryDate('31/02/2026')",context),null);
  assert.equal(vm.runInContext('normalizeHistoryDate(46000)',context),'2025-12-09');
  await vm.runInContext('forceSyncColetas()',context);
  assert.equal(calls,1); assert.match(alerts[0],/incompleta.*offline/i);
});
