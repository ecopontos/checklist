# Publicar na rede local via IIS

O app é um site estático (HTML/CSS/JS puro, sem build), mas usa `<script type="module">`
e o `sql.js` carrega um arquivo `.wasm` via `fetch()`. Navegadores bloqueiam os dois
quando a página é aberta direto de um caminho de arquivo (`file://...` ou um caminho de
rede tipo `\\servidor\pasta\index.html` aberto no Explorer) — é preciso servir os
arquivos por HTTP.

## Requisitos

- Uma máquina Windows que fique sempre ligada na rede: **Windows Server** (qualquer
  versão) ou **Windows 10/11 Pro ou Enterprise**.
- **Não funciona em Windows Home** — o recurso IIS não existe nessa edição. Se a única
  máquina disponível for Home, use um servidor leve (`npx serve` ou
  `python -m http.server`) como tarefa agendada em vez deste guia.

## 1. Habilitar o IIS

**Windows Server:**
Gerenciador do Servidor → Adicionar funções e recursos → marque **Servidor Web (IIS)** →
concluir o assistente (padrões servem).

**Windows 10/11 Pro/Enterprise:**
Painel de Controle → Programas → Ativar ou desativar recursos do Windows → marque
**Internet Information Services** → OK (reinicia se pedir).

## 2. Copiar os arquivos do app

Copie todo o conteúdo deste repositório (incluindo as pastas `vendor/` e `gas/`, exceto
`.git/`) para uma pasta na máquina, por exemplo `C:\inetpub\wwwroot\checklist`.

## 3. Registrar o tipo MIME do `.wasm`

Sem isso, `sql.js` falha ao carregar e o app não abre nenhum roteiro/cliente. Crie o
arquivo `web.config` na raiz da pasta copiada (ao lado de `index.html`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <staticContent>
      <remove fileExtension=".wasm" />
      <mimeMap fileExtension=".wasm" mimeType="application/wasm" />
    </staticContent>
  </system.webServer>
</configuration>
```

(Usar `web.config` em vez de configurar pelo IIS Manager mantém a regra junto do site,
caso ele seja movido ou recriado depois.)

## 4. Criar o site no IIS

No **Gerenciador do IIS** (`inetmgr` no menu Iniciar):

1. Botão direito em "Sites" → **Adicionar Site**.
2. Nome do site: `checklist` (ou o que preferir).
3. Caminho físico: a pasta do passo 2 (ex: `C:\inetpub\wwwroot\checklist`).
4. Porta: `80` (padrão) ou outra de sua escolha, se a 80 já estiver em uso por outro
   site nessa máquina.
5. OK.

## 5. Liberar a porta no Firewall do Windows

Painel de Controle → Firewall do Windows Defender → Configurações avançadas → Regras de
Entrada → Nova Regra → Porta → TCP → porta escolhida no passo 4 → Permitir a conexão →
aplicar para redes de Domínio/Privada (não é necessário liberar para redes Públicas).

## 6. Descobrir o endereço e testar

Na máquina que hospeda o site, rode `ipconfig` num terminal e anote o "Endereço IPv4"
(ex: `192.168.1.50`). De outro PC na mesma rede, abra um navegador em:

```
http://192.168.1.50/index.html
```

(troque a porta se não usou a 80, ex: `http://192.168.1.50:8080/index.html`)

Confirme que a página carrega sem tela em branco e sem erros no console (F12 →
Console) — se aparecer erro de MIME type do `.wasm`, revise o passo 3.

## 7. Passar o endereço para os operadores

O endereço que cada operador deve usar é a URL do passo 6, **não** um caminho de rede
(`\\servidor\...`). Para criar um atalho no desktop:

1. Botão direito na área de trabalho → Novo → Atalho.
2. Local do item: `http://192.168.1.50/index.html` (o endereço real da sua rede).
3. Nome do atalho: "SATELITE — Operação de Coleta" (ou o que preferir).

Abrir esse atalho abre a URL no navegador padrão, servida via HTTP — funciona
normalmente.

## Observação sobre atualizações

Sempre que o código deste repositório for atualizado, repita o passo 2 (copiar os
arquivos atualizados para a pasta do IIS) — o site em produção não se atualiza sozinho.
