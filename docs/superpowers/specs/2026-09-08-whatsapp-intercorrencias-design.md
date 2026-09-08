# Disparo WhatsApp — filtrar por intercorrência da planilha

## Contexto

O módulo de disparo WhatsApp (`whatsapp-sender.html`) já seleciona destinatários por roteiro, direto do banco SQLite local (`getContatosWhatsapp`, ver `docs/superpowers/specs/2026-09-08-whatsapp-sender-integracao-banco-design.md`). Falta um jeito de identificar, dentro de um roteiro, quais clientes tiveram problema na última coleta ("intercorrência" — texto livre preenchido em `coleta-operation.js`) para avisá-los especificamente.

Hoje a intercorrência só é **escrita** na aba "Coletas" da planilha (append via `pushColetas`/GAS `routeChanges`... na verdade via sync de coletas, `sheet.appendRow([...])` em `gas/Code.gs:1432`). Não existe leitura de volta. Como um roteiro pode ser coletado por qualquer dispositivo, o banco local só enxerga as coletas feitas nele mesmo — para saber a intercorrência mais recente de todo o roteiro é preciso ler a planilha, que é a fonte única compartilhada.

## Objetivo

No passo 1 do disparo (seleção de roteiro), oferecer um filtro "Só com intercorrência": ao ativar, busca na planilha a intercorrência mais recente de cada cliente do(s) roteiro(s) selecionado(s) e restringe a lista de contatos a quem tem intercorrência registrada, com o texto dela disponível para compor a mensagem via `{intercorrencia}`.

## Design

### 1. GAS — novo endpoint de leitura (`gas/Code.gs`)

Nova action `intercorrenciasRoteiro`, roteada em `doGet` (ao lado de `ultimaColeta`/`ultimaColetaDetalhada`):

```js
if (params.action === 'intercorrenciasRoteiro') {
    return getIntercorrenciasRoteiro_(params.roteiro || '');
}
```

Nova função `getIntercorrenciasRoteiro_(roteiroNome)`, no mesmo espírito de `getUltimaColetaDetalhada_` (mesma aba `Coletas`, mesma janela de `COLETAS_RECENT_ROWS` linhas recentes com fallback de varredura completa, mesmo `CacheService` de 6h com chave por `lastRow`), mas com uma diferença deliberada de semântica:

- `getUltimaColetaDetalhada_` calcula a data mais recente **do roteiro inteiro** e só devolve pontos coletados exatamente nessa data, descartando `quantidade <= 0`. Isso não serve aqui: uma intercorrência típica ("recusou coleta", "sem bombona") é registrada justamente com quantidade 0, e o cliente pode ter sido coletado num dia diferente do resto do roteiro.
- `getIntercorrenciasRoteiro_` calcula, **por `id_rota`**, a coleta de data mais recente (sem filtrar por quantidade), e inclui esse ponto no resultado somente se a coluna "Intercorrência" dessa coleta não estiver vazia.

Colunas lidas da aba `Coletas` (mesmos nomes de cabeçalho do `appendRow` em `gas/Code.gs:1432`): `ID Rota`, `Data`, `Roteiro`, `Intercorrência`.

Retorno: `{ ok: true, data: [{ id_rota, intercorrencia, data }, ...] }` — um item por cliente do roteiro com intercorrência na última coleta dele. `data` é a data normalizada da coleta (mesma função `normalizeDateValue_` já usada), incluída para permitir no futuro exibir "registrado em X" (não é exigido pela UI agora, mas é dado que já temos calculado).

Bump de `GAS_API_VERSION` de 6 para 7 (nova capacidade exposta pelo backend). Isso exige redeploy manual do Apps Script — não é algo que este repositório consiga automatizar ou testar; o plano vai marcar isso como uma etapa manual explícita para o usuário.

### 2. Cliente GAS (`google-sync.js`)

Novo wrapper, mesmo padrão de `getUltimasQuantidades`:

```js
export async function getIntercorrenciasRoteiro(roteiroNome) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    return gasGetJsonWithRetry_(
        `${url}?action=intercorrenciasRoteiro&roteiro=${encodeURIComponent(roteiroNome)}`
    );
}
```

Testado com o mesmo harness `vm` + `fetch` stubado usado em `tests/gas-route-queue.test.cjs`/`tests/rotas-rede-sync.test.cjs`: cobre URL montada corretamente, resposta repassada como veio, e erro quando a URL do GAS não está configurada.

**Risco a tratar explicitamente:** o `doGet` atual cai no `getRoteirosFlat_()` como *default* quando `action` não bate com nenhum case (`gas/Code.gs:88-90`). Se o usuário não tiver redeployado o Apps Script, chamar `action=intercorrenciasRoteiro` num deployment antigo devolve silenciosamente o payload gigante de roteiros, não um erro. O wrapper cliente não pode confiar cegamente em `data.ok`/formato — quem consome (`whatsapp-sender.html`) precisa validar que a resposta tem a forma esperada (`Array.isArray(data.data)` com objetos `{id_rota, intercorrencia}`) antes de usar, e tratar qualquer coisa fora disso como "recurso indisponível", não como lista vazia nem como crash.

### 3. `whatsapp-sender.html` — toggle e integração

No passo 1, abaixo da tabela de preview de contatos, um toggle/checkbox "Só com intercorrência" — desabilitado enquanto nenhum roteiro estiver selecionado.

Estado novo:
```js
let somenteIntercorrencia = false;
let intercorrenciasPorIdRota = new Map(); // idRota -> { intercorrencia, data }
let intercorrenciasCarregadas = new Set(); // nomes de roteiro já buscados nesta sessão
```

Ao ligar o toggle (ou ao mudar a seleção de roteiros com o toggle já ligado): para cada roteiro selecionado ainda não presente em `intercorrenciasCarregadas`, chama `getIntercorrenciasRoteiro(roteiroNome)`, valida o formato da resposta (ver risco acima), acumula em `intercorrenciasPorIdRota` e marca o roteiro como carregado. Mostra um estado de carregamento simples (texto "Buscando intercorrências..." no lugar da tabela) enquanto isso acontece. Erro de rede/formato inesperado → mensagem de erro inline junto do toggle, toggle volta para desligado, resto do fluxo não é afetado.

`renderContactPreview()` passa a filtrar por `!somenteIntercorrencia || intercorrenciasPorIdRota.has(c.idRota)` antes de renderizar, e adiciona uma coluna "Intercorrência" na tabela quando o toggle está ligado, com o texto vindo de `intercorrenciasPorIdRota.get(c.idRota).intercorrencia`.

`buildMsg(contact)` ganha uma segunda substituição:
```js
const intercorrencia = (intercorrenciasPorIdRota.get(contact.idRota) || {}).intercorrencia || '';
return message.replace(/\{nome\}/gi, nome).replace(/\{intercorrencia\}/gi, intercorrencia);
```
Se o toggle nunca foi ligado (mapa vazio) e a mensagem usa `{intercorrencia}`, o texto simplesmente vira vazio — sem placeholder literal vazando pro cliente, sem erro.

Dica visual da tag: `<div class="tag-hint">Use <code>{nome}</code> ... e <code>{intercorrencia}</code> para citar o problema registrado na última coleta.</div>`.

Contagem nos chips de roteiro **não muda** com o toggle — continua sendo o total de contatos elegíveis por telefone (como hoje), não o total com intercorrência. Calcular isso exigiria uma chamada GAS por roteiro só para popular números nos chips não selecionados, o que não se paga para o caso de uso (avisar quem já está com roteiro escolhido).

## Fora de escopo

- Categorizar/estruturar o texto livre da intercorrência (continua string livre, como hoje).
- Mostrar intercorrência de coletas anteriores à mais recente (histórico) — só a última coleta de cada cliente conta.
- Atualizar a contagem dos chips de roteiro para refletir "quantos têm intercorrência" antes de selecionar.
- Qualquer mudança em como a intercorrência é registrada/enviada no momento da coleta (`coleta-operation.js`) — este trabalho é só de leitura.
