# Destaque de novos pontos na tela de coleta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar na tela interativa de coleta (`renderList`) o mesmo destaque de novos pontos que já existe no PDF e na impressão — um badge `NOVO` na linha e um aviso com a contagem no topo da lista.

**Architecture:** Pura apresentação em `coleta-operation.js`, reaproveitando `listarNovidades`/`tituloNovidades` de `roteiro-novidades.js` (mesma fonte do PDF). Sem alterações em banco, GAS ou sincronização. Estilo em `coleta-desktop.css`.

**Tech Stack:** JavaScript ES modules (browser), testes com `node:test` + `vm` (SourceTextModule/SyntheticModule), PWA com precache em `sw.js`.

## Global Constraints

- Não alterar banco, contratos de GAS nem sincronização: a fonte de verdade do que é "novo" permanece em `getNovidadesRoteiro`/`listarNovidades`.
- O conjunto exibido na tela deve ser idêntico ao do PDF: usar a mesma chamada `listarNovidades(db, routeSelect.value, currentClients)`.
- Digitar quantidade/intercorrência sem salvar NÃO remove o badge (vem de graça por ler o estado salvo do banco).
- O badge apenas marca; não reordena nem filtra a lista.
- Testes novos que usam `vm.SourceTextModule` rodam com `node --experimental-vm-modules` e precisam ser incluídos no script `test` do `package.json`.
- Versão do app vive em 3 arquivos (valores iguais): `package.json`, `src-tauri/tauri.conf.json`, `sw.js`. Bump para invalidar o cache do PWA. Não atualizar dependências.

---

### Task 1: Badge `NOVO` e aviso de contagem no `renderList`

**Files:**
- Modify: `coleta-operation.js:3` (import), `coleta-operation.js:326-389` (`renderList`)
- Create: `tests/novidades-tela.test.cjs`
- Modify: `package.json:10` (script `test`)

**Interfaces:**
- Consumes: `listarNovidades(db, roteiroId, clientes): Array<{ id_rota, cliente, ordem }>` e `tituloNovidades(quantidade): string`, ambos exportados por `roteiro-novidades.js`.
- Produces: `renderList()` passa a inserir, no `innerHTML` de `#listContainer`, um `<span class="novo-badge">NOVO</span>` dentro de um `<div class="client-cell">` para pontos retornados por `listarNovidades`, e um `<div class="novidades-aviso">` com o texto de `tituloNovidades` quando a contagem for maior que zero.

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/novidades-tela.test.cjs`:

```js
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
```

- [ ] **Step 2: Incluir o teste no script e rodar para ver falhar**

Em `package.json:10`, acrescentar ao final do valor do script `test` (antes da aspa de fechamento), após `... tests/novidades-impressao.test.cjs`:

```
 && node --experimental-vm-modules tests/novidades-tela.test.cjs
```

Run: `node --experimental-vm-modules tests/novidades-tela.test.cjs`
Expected: FAIL — `novo-badge` não aparece (contagem 0 ≠ 1) e `/1 novo ponto/` não casa, pois `renderList` ainda não renderiza o destaque.

- [ ] **Step 3: Importar `tituloNovidades`**

Em `coleta-operation.js:3`, trocar:

```js
import { listarNovidades, desenharResumoNovidades } from './roteiro-novidades.js';
```

por:

```js
import { listarNovidades, desenharResumoNovidades, tituloNovidades } from './roteiro-novidades.js';
```

- [ ] **Step 4: Calcular o conjunto de novos no início do `renderList`**

Em `coleta-operation.js`, logo após `const container = document.getElementById('listContainer');` (dentro de `renderList`), inserir:

```js
    const routeSelect = document.getElementById('routeSelect');
    const novidades = listarNovidades(db, routeSelect.value, currentClients);
    const novosIds = new Set(novidades.map(n => n.id_rota));
```

- [ ] **Step 5: Renderizar o badge na célula do cliente**

Em `renderList`, trocar a linha da célula do cliente:

```js
                <td><span class="client-name" title="${escapeHTML(client.cliente)}">${escapeHTML(client.cliente)}</span></td>
```

por:

```js
                <td><div class="client-cell">${novosIds.has(String(client.id_rota)) ? '<span class="novo-badge">NOVO</span>' : ''}<span class="client-name" title="${escapeHTML(client.cliente)}">${escapeHTML(client.cliente)}</span></div></td>
```

- [ ] **Step 6: Renderizar o aviso no topo da lista**

Em `renderList`, trocar:

```js
    container.innerHTML = `
        <div class="table-toolbar">
```

por:

```js
    const aviso = novidades.length
        ? `<div class="novidades-aviso" role="status">${escapeHTML(tituloNovidades(novidades.length))}</div>`
        : '';
    container.innerHTML = `
        ${aviso}
        <div class="table-toolbar">
```

- [ ] **Step 7: Rodar o teste e confirmar que passa**

Run: `node --experimental-vm-modules tests/novidades-tela.test.cjs`
Expected: PASS (2 testes).

- [ ] **Step 8: Rodar a suíte relacionada para garantir que nada regrediu**

Run: `node tests/coleta-operation.test.cjs && node --experimental-vm-modules tests/novidades-impressao.test.cjs`
Expected: PASS em ambos (regressões de source e paridade do PDF intactas).

- [ ] **Step 9: Commit**

```bash
git add coleta-operation.js tests/novidades-tela.test.cjs package.json
git commit -m "feat: destacar novos pontos na tela de coleta"
```

---

### Task 2: Estilo do badge/aviso e bump de versão

**Files:**
- Modify: `coleta-desktop.css` (após o bloco `.status-badge`, ~linha 462; e junto a `.client-name`, ~linha 414)
- Modify: `package.json:3`, `src-tauri/tauri.conf.json:4`, `sw.js:5` (versão `1.8.1` → `1.8.2`)

**Interfaces:**
- Consumes: classes `.client-cell`, `.novo-badge`, `.novidades-aviso` emitidas por `renderList` na Task 1.
- Produces: nenhuma interface de código; apenas estilo e invalidação de cache do PWA.

- [ ] **Step 1: Adicionar o estilo do badge e do aviso**

Em `coleta-desktop.css`, após o bloco `.status-badge.issue .status-dot { ... }` (final do grupo de badges, ~linha 462), inserir:

```css
.client-cell {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.novo-badge {
    flex: none;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--danger);
    color: #0b0e14;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.04em;
}

.novidades-aviso {
    margin-bottom: 8px;
    padding: 8px 12px;
    border: 1px solid var(--danger);
    border-radius: 7px;
    color: var(--danger);
    font-weight: 700;
    font-size: 0.82rem;
}
```

Nota: `.client-cell` é flex para o badge ficar inline e o `.client-name` continuar truncando com reticências (`min-width: 0` permite o encolhimento do filho). `--danger` dá o tom de atenção, consistente com o status de intercorrência.

- [ ] **Step 2: Bump de versão para invalidar o cache do PWA**

Trocar `1.8.1` por `1.8.2` em:
- `package.json:3` — `"version": "1.8.1",`
- `src-tauri/tauri.conf.json:4` — `"version": "1.8.1",`
- `sw.js:5` — `const VERSION = '1.8.1';`

- [ ] **Step 3: Rodar a suíte completa**

Run: `npm test`
Expected: PASS (inclui `tests/novidades-tela.test.cjs`).

- [ ] **Step 4: Conferência visual**

Abrir `coleta-checklist.html`, selecionar um roteiro com inclusão pendente e confirmar: badge `NOVO` inline antes do nome, aviso "ATENÇÃO: X novos pontos neste roteiro" no topo, nomes longos ainda truncando. Selecionar um roteiro sem novidades e confirmar ausência de badge e de aviso.

- [ ] **Step 5: Commit**

```bash
git add coleta-desktop.css package.json src-tauri/tauri.conf.json sw.js
git commit -m "chore: estilo do destaque de novos pontos e versao 1.8.2"
```

---

## Self-Review

**Spec coverage:**
- Badge `NOVO` na linha → Task 1 Steps 4-5. ✓
- Aviso com contagem no topo → Task 1 Steps 4,6. ✓
- Mesma fonte do PDF (`listarNovidades`) → Task 1 Step 4. ✓
- Digitar sem salvar mantém o badge → garantido por ler estado salvo do banco; coberto implicitamente (teste usa `addColeta` salvo para limpar). ✓
- Ponto permanece na sequência, só marca → badge dentro da célula, sem reordenar. ✓
- Sem mudança em banco/GAS/sync → nenhuma task toca esses caminhos. ✓
- Estilo alinhado aos badges existentes → Task 2 Step 1. ✓
- Verificação (badge só nos novos; aviso oculto em 0; visual) → Task 1 Steps 1-2,7; Task 2 Step 4. ✓

**Placeholder scan:** Sem TBD/TODO; todo passo traz código/comando concreto. ✓

**Type consistency:** `novosIds` (Set de strings de `n.id_rota`), comparado com `String(client.id_rota)`; `tituloNovidades(novidades.length)`; classes `.client-cell`/`.novo-badge`/`.novidades-aviso` idênticas entre Task 1 (emissão) e Task 2 (estilo). ✓
