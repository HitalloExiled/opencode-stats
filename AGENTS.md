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
bun test test              # testes puros (metrics/history/chart/prompt/capture/scheduler/observability/rpc)
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
  scheduler.ts           # fila adiada e coalescida da captura
  observability.ts       # interruptor em memória + ctx.storage
  runtime.ts             # store/scheduler/observability globais
  metrics.ts             # métricas puras da transcrição
  history.ts             # ring buffer/escala/paths (puro)
  format.ts              # formatação locale-aware
  gui.tsx                # Plugin.define da GUI (./gui-experimental)
  gui/
    contract.ts          # StatsRpc + tipos PromptPart/PromptCapture/ObservabilityStatus
    setup.tsx            # Panel (abas stats/prompt) + Command + MenuItem
    stats.tsx            # aba Estatísticas
    prompt.tsx           # aba System prompt
    observability.ts     # estado compartilhado do interruptor + visibilidade
    gauge.tsx            # gauge SVG semicircular
    chart.tsx            # gráfico de linha/área SVG
    header.tsx           # Slot session.header
    i18n.ts              # PT-BR + EN-US
test/                    # bun:test das funções puras
```

## Servidor

- `index.ts` registra `ctx.session.hook("context", ...)` e
  `ctx.rpc.register(StatsRpc, handlers)`; o teardown descarta as duas
  assinaturas.
- O hook **não pode bloquear o caminho do request**: ele só lê
  `event.system.slice()`, `event.agent` e `event.model` e chama
  `runtime.scheduler.enqueue(...)`. Nada de classificação, contagem de bytes ou
  hash inline: esse trabalho atrasaria o request e distorceria o tok/s medido.
  Nunca deixe uma exceção da captura derrubar o request do modelo: o callback
  tem `try/catch` e loga em `console.error`.
- `src/scheduler.ts` guarda a última captura por sessão e drena no próximo
  `setImmediate`. Coalesce por sessão (a mais recente vence), conta
  `captured/coalesced/batches/dropped/errors`, mede lag e tempo de flush e
  engole falhas de captura via `onError`. `setEnabled(false)` descarta a fila.
- `src/observability.ts` mantém o interruptor **síncrono** lido pelo hook
  (default `true`), hidratado de `ctx.storage.get("observability")` e persistido
  com escrita serializada. Desligar limpa o store e a fila; religar retoma no
  próximo request. Um toggle explícito vence uma hidratação tardia.
- `src/runtime.ts` mantém store, scheduler e observabilidade em
  `globalThis.__opencodeStatsRuntime__`: um hot reload registra uma RPC nova
  enquanto uma rota antiga ainda pode servir a janela, e o hook pode pertencer a
  qualquer geração. O teardown **não** limpa o runtime; só o usuário desliga.
  Mantenha essa propriedade se refatorar o ciclo de vida.
- A RPC `opencode.stats/systemPrompt` recebe `{ sessionID, ifNoneMatch? }` e
  devolve `{ status: "missing" }`, `{ status: "unchanged", hash, capturedAt,
  requestCount }` ou `{ status: "capture", capture }`. `observability` devolve o
  status do pipeline e `setObservability({ enabled })` alterna e persiste.
- `src/prompt.ts` é puro e não importa nada do runtime do servidor; ele expande
  `metadata.experimental.instructions` e classifica as chaves:
  - `core/instructions` → grupo `added`;
  - `api/*` → grupo `dynamic`, com `detail`;
  - demais `core/*` → grupo `fixed`;
  - partes extras → `dynamic`, com detecção de tags de plugins.
- `src/capture.ts` guarda a última captura por sessão em memória, deduplica por
  SHA-256, conta requests e aplica LRU por número de sessões e bytes totais.
  `peek` lê sem tocar no LRU (usado pelo status). Não persiste nada.

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
  sessão. O setup também registra o comando e a entrada de menu
  **Ativar/Desativar observabilidade** (título reativo pelo signal).
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
  - prompt: `client.rpc(StatsRpc).systemPrompt({ sessionID, ifNoneMatch }, ...)`
    com `{ location: { directory: session.directory } }`; trate os três
    `status` (`missing`/`unchanged`/`capture`);
  - interruptor: `observability()` / `setObservability({ enabled })`.
- `src/gui/observability.ts` guarda o status do interruptor em um signal de
  módulo, compartilhado por `StatsView`, `StatsStrip` e `PromptView` (o estado é
  global ao processo). Não mantenha cópia local em cada componente.
- Com a observabilidade desligada, a aba Estatísticas mostra só o estado
  desativado com o botão de reativar, a faixa do cabeçalho some e a aba do
  prompt não chama a RPC. O sampler de 1 Hz, o fetch de `session.context` e o
  ponto exato do passo só rodam com ela ligada e com o documento visível.
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
