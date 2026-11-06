# AGENTS.md — opencode-stats

Plugin do OpenCode V2 com duas partes: um **servidor** que captura o system
prompt e uma **GUI** SolidJS que desenha as abas Estatísticas e System prompt.

## Build, typecheck e testes

Na raiz do plugin:

```bash
npm install --legacy-peer-deps
npm run typecheck          # tsc --noEmit (index.ts + src/**/*.ts)
npm run typecheck:gui      # tsc --noEmit -p tsconfig.gui.json
npm run gui:build          # vite build -> dist/gui-experimental.cjs
npm run gui:watch          # rebuild contínuo
bun test test              # testes puros (metrics/history/chart/prompt/capture)
```

No repo pai (`opencode-tools`):

```bash
bun run typecheck
bun test plugins/stats/test
```

O `dist/` não é versionado. O `setup.sh` do repo pai roda `npm install` e
`npm run gui:build` dentro de `plugins/stats`.

## Layout

```text
index.ts                 # Plugin.define do servidor
src/
  capture.ts             # store em memória (dedupe por hash, LRU)
  prompt.ts              # classificação pura do system prompt
  rpc.ts                 # RpcHandlers<typeof StatsRpc>
  metrics.ts             # métricas puras da transcrição
  history.ts             # ring buffer/escala/paths (puro)
  format.ts              # formatação locale-aware
  gui.tsx                # Plugin.define da GUI (./gui-experimental)
  gui/
    contract.ts          # StatsRpc + tipos PromptPart/PromptCapture
    setup.tsx            # Panel (abas stats/prompt) + Command + MenuItem
    stats.tsx            # aba Estatísticas
    prompt.tsx           # aba System prompt
    gauge.tsx            # gauge SVG semicircular
    chart.tsx            # gráfico de linha/área SVG
    header.tsx           # Slot session.header
    i18n.ts              # PT-BR + EN-US
test/                    # bun:test das funções puras
```

## Servidor

- `index.ts` registra `ctx.session.hook("context", ...)` e
  `ctx.rpc.register(StatsRpc, handlers)`; o teardown descarta as duas
  assinaturas e limpa o store.
- O hook captura `event.system: SystemPart[]`, `event.agent` e `event.model`.
  Nunca deixe uma exceção da captura derrubar o request do modelo: o callback
  tem `try/catch` e loga em `console.error`.
- `src/prompt.ts` é puro e não importa nada do runtime do servidor; ele expande
  `metadata.experimental.instructions` e classifica as chaves:
  - `core/instructions` → grupo `added`;
  - `api/*` → grupo `dynamic`, com `detail`;
  - demais `core/*` → grupo `fixed`;
  - partes extras → `dynamic`, com detecção de tags de plugins.
- `src/capture.ts` guarda a última captura por sessão em memória, deduplica por
  SHA-256, conta requests e aplica LRU por número de sessões e bytes totais.
  Não persiste nada.
- O store é **process-global** (`globalThis.__opencodeStatsCaptureStore__`), não
  criado dentro de `setup`: um hot reload registra uma RPC nova enquanto uma
  rota antiga ainda pode servir a janela, e o hook que captura pode pertencer a
  qualquer geração. O teardown **não** limpa o store; o processo o libera ao
  sair. Mantenha essa propriedade se refatorar o ciclo de vida.
- A RPC `opencode.stats/systemPrompt` recebe `{ sessionID }` e devolve
  `PromptCapture | null`.

A ordem de carregamento importa: `stats` é carregado depois de `memory`,
`notes` e `plans` (ordem alfabética dos diretórios), então vê os blocos que eles
empilham em `system`. Um plugin carregado depois do `stats` pode não ser
classificado; documente isso se for adicionar um fallback.

## GUI

- `src/gui/setup.tsx` registra um `Panel` com duas abas:
  - `stats` — fechável (como a `prompt`), renderiza `StatsView`; reabre pelo
    comando ou pelo menu do painel;
  - `prompt` — abre pelo comando/menu, renderiza `PromptView` quando está em
    `input.open`.
  O `render` é keyed por `props.session.key` para zerar buffers ao trocar de
  sessão.
- `usePlugin()` só funciona dentro de contributions. **Não use `useT()` no
  setup**; leia `ctx.locale.locale()` diretamente (o setup não está sob o
  provider).
- `src/gui/contract.ts` é compartilhado entre servidor e GUI; importe apenas
  tipos na GUI quando possível.
- A GUI não pode importar `@opencode/util/session-turn` nem bibliotecas de
  chart: o `gui()` do Vite só externaliza os módulos que o app fornece. A
  fórmula de tok/s e os paths SVG são locais.
- Dados:
  - métricas ao vivo: `session.server.data.session.message.list(id)`;
  - histórico ativo: `client.session.context({ sessionID })`, mesclado por id
    com a janela viva;
  - status: `data.session.status(id)`;
  - prompt: `client.rpc(StatsRpc).systemPrompt(...)` com
    `{ location: { directory: session.directory } }`.
- O ring buffer de tok/s guarda 300 amostras por turno, amostra a 1 Hz enquanto
  `running`. O ponto exato entra quando o passo completa. A escala do gauge só
  cresce (`niceScale`).
- Layout: use as variáveis `--v2-*` com fallback (como `notes`/`plans`) para
  funcionar nos temas claro e escuro. O bundle carrega o próprio CSS em
  `<style>`.

## i18n e convenções

- **Toda string visível existe em PT-BR e EN-US**, com EN-US como fallback
  (`src/gui/i18n.ts`). Código e identificadores em inglês.
- Rótulos vindos do servidor usam `labelKey` para as fontes conhecidas; o
  `label` neutro é só fallback para chaves desconhecidas.
- Não grave arquivos no repositório em runtime. Copiar/salvar o prompt são
  ações explícitas do usuário (`ctx.system.copy` / `ctx.system.save`).
- Não leia `opencode.db` nem crie um banco novo.

## Git

Este repositório é um **submodule** em `opencode-tools/plugins/stats`. O fluxo
de duas partes:

1. commit + push aqui (`git push origin main`);
2. no repo pai, `git add plugins/stats`, commit do ponteiro e push.

Nunca commite mudanças daqui pelo repo pai.
