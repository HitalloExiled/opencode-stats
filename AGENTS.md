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
bun test test              # testes puros (metrics/history/chart/cost/prompt/capture/scheduler/observability/rpc)
```

No repo pai (`opencode-tools`):

```bash
bun run typecheck
bun test plugins/stats/test
```

O `dist/` não é versionado. O `setup.sh` do repo pai roda `npm install` e
`npm run gui:build` dentro de `plugins/stats`.

## Layout

O contrato visual e de comportamento dos painéis é
[docs/gui-guideline.md](https://github.com/HitalloExiled/opencode-tools/blob/main/docs/gui-guideline.md).
Código de GUI comum a mais de um plugin vive em
`opencode-shared/gui` (submodule `shared/` do repo pai, linkado
em `node_modules` pelo `setup.sh`) — não copie para cá.

Regras: só tokens `--v2-*` (status em `--v2-state-*`, sem hex cru); controles de
`ctx.ui.*`; um container de scroll por painel com o `ScrollNav` do shared
(scroll infinito, botões ao topo/ao fim, Home/End/PageUp/PageDown); toda string
em `src/gui/i18n.ts` (PT-BR + EN-US); estados e chip do shared.


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
    context-chart.tsx    # crescimento do contexto + checkpoints
    cost-chart.tsx       # custo por provider + projeção + limite
    cost-source.ts       # custo por fatia/provider via session.stats + cache
    cost-settings.ts     # limite, já gasto e janela persistidos (global)
    header.tsx           # Slot session.header
    i18n.ts              # PT-BR + EN-US
test/                    # bun:test das funções puras
```

## Servidor

- `index.ts` registra `ctx.session.hook("context", ...)`,
  `ctx.session.hook("compaction", ...)` e `ctx.rpc.register(StatsRpc, handlers)`;
  o teardown descarta as assinaturas. A compactação **não** dispara o hook
  `context`: ela usa o hook `compaction`, então os dois precisam capturar. Se o
  evento de compactação já trouxer `result` (outro plugin forneceu o resumo),
  não há request e a captura é ignorada.
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
- O runtime tem `RUNTIME_VERSION`: **incremente** ao mudar o formato do store,
  scheduler ou observability. Sem o bump, o hot reload mantém o objeto antigo e
  a RPC nova chama métodos que ele não tem (ex.: `peek`). O runtime anterior é
  descartado e tem store/fila limpos ao trocar de versão.
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
  SHA-256 (incluindo as definições de tools), conta requests e aplica LRU por
  número de sessões e bytes totais. Guarda os bytes do system prompt (`totalBytes`)
  e das definições de tools (`toolBytes`). `peek` lê sem tocar no LRU (usado pelo
  status). Não persiste nada.

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
  sessão. O setup também registra o comando **Ativar/Desativar observabilidade**
  (título reativo pelo signal); a entrada de menu correspondente foi removida —
  o toggle fica no cabeçalho da aba Estatísticas e na paleta de comandos.
- `src/gui/prompt.tsx` renderiza cada parte com `ctx.ui.Markdown` (componente do
  host, sem dependência no bundle). O toggle **Markdown | Bruto** mantém o
  `<pre>` original para inspeção; copiar/salvar e o filtro operam no texto bruto.
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
  - histórico ativo: `client.session.context({ sessionID })`; `mergeMessages`
    cruza por id com a janela viva e mantém só o recorte ativo (visão
    **Contexto**); `mergeTimeline` cruza sem recorte (tok/s, turno, reasoning e
    totais) — uma compactação **não** pode zerar a leitura do painel;
  - status: `data.session.status(id)`;
  - prompt: `client.rpc(StatsRpc).systemPrompt({ sessionID, ifNoneMatch }, ...)`
    com `{ location: { directory: session.directory } }`; trate os três
    `status` (`missing`/`unchanged`/`capture`);
  - interruptor: `observability()` / `setObservability({ enabled })`;
  - custo por provider: `client.session.stats({ from, to, timezone, tools:
    "none" })` **uma vez por fatia do eixo** (dia local inteiro, o trecho do
    marco zero até o fim do dia, ou o início de hoje até agora), de
    `src/gui/cost-source.ts`. Sem `project`, a chamada agrega a **máquina
    inteira** (validado contra o servidor: a soma por projeto bate com a chamada
    sem filtro) e `models[]` traz `model.providerID` + `cost`. Nunca leia
    `opencode.db`. Fatias encerradas antes de hoje ficam em cache permanente; a
    que alcança hoje expira em `COST_TODAY_TTL_MS` (~30 s); o cache é um LRU de
    128 chaves `from|to`, independente do provider e do marco zero (o custo de
    uma fatia não muda com o baseline), limpo no refresh;
    concorrência limitada a 4 e abort cooperativo (o signal só é checado entre
    chamadas porque o typecheck do servidor não tem DOM).
- `src/gui/cost-chart.tsx` desenha o card **Custo e projeção** (depois de
  **Sessão**): eixo X em tempo (não índice), eixo Y em USD, linha real
  acumulada e projeção tracejada com inclinação = custo médio diário
  (`src/cost.ts`, puro), linha de corte no **Limite** e marcador/data no
  cruzamento. A janela (10/15/30 dias), o limite e o **Já gasto** ficam em
  `src/gui/cost-settings.ts`, um store **global** (`ctx.storage.store`) com um
  registro por provider. O `costSettingsFor` mantém uma cópia **autoritativa**
  em `createSignal` e escreve no store com `set(...)` (valor inteiro, não
  `update` aninhado): o `.value` do store não re-renderizava os memos depois de
  um `update`, então digitar um limite novo não chegava ao gráfico. A semeadura
  do store só acontece uma vez, quando `ready()` fica verdadeiro, e nunca
  sobrescreve uma edição feita antes.
  **Já gasto é um marco zero:** ao editar o campo (valor diferente do atual) o
  settings carimba `spentAt = agora`; o card conta o custo medido **a partir
  desse instante**, não a janela inteira. `costRanges(now, janela, spentAt)`
  devolve o eixo começando no marco (ou no início da janela, quando o marco é
  mais antigo, com o gasto intermediário num `offset` somado ao baseline). A
  média divide pelo tempo decorrido desde o marco (piso de 1 dia); sem marco,
  divide pela janela. O cruzamento do limite parte de `baseline + total`.
  Cada tecla em `Já gasto` carimba um marco novo: o reload é debounced em
  `COST_MARK_DEBOUNCE_MS` (~300 ms) e aborta o anterior, enquanto janela,
  provider e refresh carregam na hora. O cache de fatias **não** é limpo pelo
  marco: o custo de um intervalo não depende do baseline.
  O SVG é medido **no próprio `<section class="stats-card">`**, que é sempre
  renderizado — nunca dentro do `<Show when={provider()}>` condicional, senão o
  `ResizeObserver` montado no `onMount` não acha o host (os dados chegam depois)
  e o SVG de 360 px é esticado até a largura do card por
  `preserveAspectRatio="none"`. O fetch só roda com o painel visível e a
  observabilidade ligada; o botão de refresh limpa o cache.
- `src/gui/observability.ts` guarda o status do interruptor em um signal de
  módulo, compartilhado por `StatsView`, `StatsStrip` e `PromptView` (o estado é
  global ao processo). Não mantenha cópia local em cada componente.
- Com a observabilidade desligada, a aba Estatísticas mostra só o estado
  desativado com o botão de reativar, a faixa do cabeçalho some e a aba do
  prompt não chama a RPC. O sampler de 1 Hz, o fetch de `session.context` e o
  ponto exato do passo só rodam com ela ligada e com o documento visível.
- O ring buffer de tok/s guarda 300 amostras por turno, amostra a 1 Hz enquanto
  `running`. O ponto exato entra quando o passo completa. A escala do gauge só
  cresce (`niceScale`); o eixo Y do gráfico é dinâmico (`chartScale`), calculado
  a partir do pico e da média das amostras **dentro da janela exibida** (Turno
  ou Sessão), então os rótulos precisam ser reativos.
- O gráfico de crescimento do contexto (`src/gui/context-chart.tsx`) usa um
  ponto por request da timeline (`input + cache.read + cache.write`) e desenha
  uma linha vertical em cada compactação `completed` — checkpoint visual, sem
  persistência. `running`/`failed` não marcam reset. O eixo Y em tokens usa
  `tokenScale`; o **eixo X é o índice do request** (`normalizeByIndex`), não
  tempo — os pontos ficam igualmente espaçados, sem relação com o intervalo
  real entre requests. O cabeçalho mostra o último valor e o total acumulado
  da sessão (`accumulatedTokens`, sem reset na compactação, sempre sobre a
  série completa, via prop `accumulated`). `stats.tsx` passa a série e os
  checkpoints **completos** (sem recortar); o próprio `ContextChart` aplica a
  janela deslizante por contagem de requests (`requestWindow`,
  `requestWindowCheckpoints`, `CONTEXT_WINDOW_SIZES` = 100/300/500, default
  `CONTEXT_WINDOW_DEFAULT` = 300) com um signal interno e um seletor no
  cabeçalho (reaproveita a classe `.stats-token-view`); `checkpointIndex`
  posiciona cada checkpoint entre os dois requests da janela em que ele caiu.
  A visão é best effort para mensagens que já saíram da janela viva da
  timeline.
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
