# Disparo WhatsApp — tags `{residuo}` e `{data}` — Implementation Plan

> **Plano revisado:** substitui integralmente a versão que cadastrava
> `Tipo de Resíduo` em `tblRoteiros` e o propagava pelo GAS e pelo SQLite.

**Goal:** preencher `{residuo}` no standalone por regras locais associadas ao
nome do roteiro e preencher `{data}` com a data da coleta que contém a
intercorrência.

**Architecture:** `config.js` mantém o mapeamento versionado e expõe uma função
pura de resolução. `whatsapp-sender.html` recebe `roteiroNome` dos contatos,
consulta essa função ao montar a mensagem e mantém data/intercorrência vindas do
endpoint já existente. O fluxo não altera o contrato GAS nem o schema SQLite.

## Global Constraints

- O tipo é resolvido somente para o standalone deste repositório.
- Padrões com `*` correspondem por prefixo; padrões sem `*`, por nome exato.
- A comparação é case-insensitive e a primeira regra encontrada vence.
- Roteiro desconhecido produz `''`; não bloquear o disparo.
- Não criar nem ler `Tipo de Resíduo` em `tblRoteiros`.
- Não adicionar `TipoResiduo` ao `action=roteiros`.
- Não persistir `tipo_residuo` no SQLite.
- A fonte de resíduo do futuro `desktop/logistics` fica para sua própria spec.

---

## Task 1: Configuração local e teste da resolução

**Files:**

- Modify: `config.js`
- Create: `tests/roteiro-tipo-residuo-config.test.cjs`
- Modify: `package.json`

- [ ] Definir `window.ROTEIRO_TIPOS_RESIDUO` com os grupos iniciais:
  - `SAT*`, `SOBI*`, `SatEpan`, `ESCOLA-ORGANICO-*` → `Organicos`;
  - `SV*` → `Vidro`.
- [ ] Implementar `window.getTipoResiduoPorRoteiro(roteiroNome)` conforme as
  restrições globais.
- [ ] Testar nomes conhecidos, variações de caixa, roteiro desconhecido e nome
  vazio.
- [ ] Registrar o teste na suíte principal.

---

## Task 2: Usar as tags na mensagem

**Files:**

- Modify: `whatsapp-sender.html`

- [ ] Carregar `config.js` e `config.local.js` antes do módulo da página.
- [ ] Manter `formatDateBR` convertendo `AAAA-MM-DD` para `DD/MM/AAAA`.
- [ ] Em `buildMsg(contact)`, resolver `{residuo}` com
  `window.getTipoResiduoPorRoteiro(contact.roteiroNome)`.
- [ ] Substituir `{nome}`, `{intercorrencia}`, `{data}` e `{residuo}` sem
  distinguir caixa.
- [ ] Atualizar a dica da interface para listar as quatro tags.

---

## Task 3: Remover a cadeia substituída

**Files:**

- Modify: `gas/Code.gs`
- Modify: `database.js`
- Modify: `tests/whatsapp-contatos.test.cjs`
- Delete: `tests/gas-roteiro-tipo-residuo.test.cjs`
- Delete: `tests/import-roteiro-tipo-residuo.test.cjs`

- [ ] Remover `TipoResiduo` das linhas produzidas pelo builder GAS.
- [ ] Remover a migração e o acesso a `roteiros.tipo_residuo`.
- [ ] Restaurar `addRoteiro(nome)` e manter `getContatosWhatsapp` expondo
  `roteiroNome`, sem `tipoResiduo`.
- [ ] Remover os testes que exigiam propagação GAS/SQLite e ajustar o teste de
  contatos ao contrato atual.

---

## Task 4: Verificação

- [ ] Rodar `npm test` e confirmar a suíte completa.
- [ ] Confirmar que as únicas referências de runtime a
  `ROTEIRO_TIPOS_RESIDUO`/`getTipoResiduoPorRoteiro` estão na configuração e no
  disparo de WhatsApp.
- [ ] Confirmar que não restaram referências de runtime a `TipoResiduo` ou
  `tipo_residuo` no GAS e no banco local.

## Notas de integração

O redeploy necessário para publicar o novo contrato normalizado
`action=roteiros` é tratado no plano de 2026-09-15. A ingestão no
`desktop/logistics` é uma entrega separada e não faz parte deste plano.
