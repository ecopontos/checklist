const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function load(syncPendingColetas) {
  const listeners = {}, intervals = new Map(); let nextInterval = 0;
  const context = vm.createContext({ console,
    window: { addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; } },
    document: { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; } },
    setInterval: fn => { const id = ++nextInterval; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id)
  });
  const dependency = new vm.SyntheticModule(['syncPendingColetas'], function () { this.setExport('syncPendingColetas', syncPendingColetas); }, { context });
  const mod = new vm.SourceTextModule(fs.existsSync('coleta-sync.js') ? fs.readFileSync('coleta-sync.js','utf8') : '', { context });
  await dependency.link(() => {}); await dependency.evaluate();
  await mod.link(() => dependency); await mod.evaluate();
  return { api: mod.namespace, listeners, intervals, context };
}

test('coordenador serializa chamadas, informa estado e reenvia ao voltar online', async () => {
  let release, calls = 0; const states = [], results = [];
  const h = await load(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const coordinator = h.api.startColetaSync({}, { autoStart: false, intervalMs: 100,
    onState: state => states.push(state), onResult: result => results.push(result) });
  const first = coordinator.refresh(); const second = coordinator.refresh();
  assert.equal(first, second); assert.equal(calls, 1); assert.deepEqual(states, ['syncing']);
  release({ ok:true, count:2, pending:0 }); await first;
  assert.equal(results[0].pending, 0); assert.equal(states.at(-1), 'idle');
  h.listeners.online(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); release({ ok:true, count:0, pending:0 }); await new Promise(resolve => setImmediate(resolve));
  coordinator.stop(); assert.equal(h.intervals.size, 0); assert.equal(h.listeners.online, undefined);
});

test('falha vira estado pendente e visibilidade só dispara quando visível', async () => {
  let calls = 0; const states = [];
  const h = await load(async () => { calls++; return { ok:false, error:'offline', pending:3 }; });
  const coordinator = h.api.startColetaSync({}, { autoStart:false, onState:s=>states.push(s) });
  await coordinator.refresh(); assert.deepEqual(states, ['syncing','pending']);
  h.context.document.visibilityState = 'hidden'; h.listeners.visibilitychange(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls,1);
  h.context.document.visibilityState = 'visible'; h.listeners.visibilitychange(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls,2);
  coordinator.stop();
});
