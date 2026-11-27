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
bun test test              # testes puros (metrics/history/chart/cost/gateway/prompt/capture/scheduler/observability/rpc)
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
  gateway.ts             # gasto da chave no gateway LiteLLM (só servidor)
  gui.tsx                # Plugin.define da GUI (./gui-experimental)
  gui/
    contract.ts          # StatsRpc + tipos PromptPart/PromptCapture/ObservabilityStatus/GatewayInfo
    setup.tsx            # Panel (abas stats/prompt) + Command + MenuItem
    stats.tsx            # aba Estatísticas
    prompt.tsx           # aba System prompt
    observability.ts     # estado compartilhado do interruptor + visibilidade
    gauge.tsx            # gauge SVG semicircular
    chart.tsx            # gráfico de linha/área SVG
    context-chart.tsx    # crescimento do contexto + checkpoints
    cost-chart.tsx       # custo por provider + projeção + limite
    cost-config.tsx      # modal de configuração (valida e grava no save)
    cost-source.ts       # custo por fatia/provider via session.stats + cache
    cost-settings.ts     # recarga, limite, já gasto e janela persistidos (global)
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
- `src/gateway.ts` lê o gasto real da chave no gateway do provider
  (`GET {baseURL}/key/info`), com `baseURL` vindo de
  `ctx.provider.get({ providerID }).data.settings.baseURL`. A chave é digitada
  na modal e guardada **no servidor** em `ctx.storage` (`gateway.key.<providerID>`,
  texto plano); ela **nunca** volta na RPC, que carrega só o spend. As chamadas
  `gateway` / `setGatewayKey` / `clearGatewayKey` da `StatsRpc` delegam para o
  serviço: cache de ~30 s por provider, coalescência de fetches concorrentes e
  geração por provider (trocar/remover a chave invalida um fetch em voo). O
  parse aceita `info.spend`, `info.max_budget` (null = sem limite),
  `info.budget_duration` e `info.budget_reset_at` (ISO, epoch em s ou em ms).
  Falha de rede/5xx/JSON inesperado vira `status:"error"` com `hasKey: true`;
  401/403 marca `invalidKey`, exceto quando o corpo mostra que a chave é válida e
  o gateway bloqueia a rota (`allowed_routes`): aí vira `routeBlocked` e a chave
  continua guardada. Salvar com chave em branco mantém a atual; salvar
  uma chave nova **valida antes de gravar** (401/403 não grava e devolve
  `invalid`), e uma falha de rede guarda a chave e devolve `unavailable`.
  `createGateway` recebe storage, providers, fetch e clock injetados, por isso
  tem teste puro em `test/gateway.test.ts`.
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
  **Sessão**): eixo X em tempo (não índice), eixo Y em **% do limite** quando há
  limite positivo (0/50/100/150+, linha de 100%) e em USD quando não há, uso
  acumulado suavizado (monotone cubic), projeção com inclinação = custo médio
  diário (`src/cost.ts`, puro), faixa futura hachurada e data do cruzamento. O
  eixo X marca **hoje** primeiro, depois um checkpoint a cada 10 dias
  (`COST_TICK_DAYS`, `forecastTicks`) e a **data do hit** (o cruzamento do
  limite) por último, em destaque mesmo caindo na projeção; cada checkpoint tem
  um guia tracejado no plot e `fitCheckpoints` (puro) resolve colisão com
  prioridade hit > hoje > anterior, então a data que responde "quando o saldo
  acaba" nunca some. O
  card é **só leitura**: o provider é navegação e continua no cabeçalho, mas
  todos os campos editáveis — limite, **Já gasto**, **Última recarga** e a
  janela (10/15/30 dias) — vivem na modal de `src/gui/cost-config.tsx`, aberta
  por **Configurar** e por **Repus créditos** (esta com a recarga preenchida com
  agora). Nada é gravado ao digitar: `Salvar` roda `validateCostConfig` sobre o
  rascunho inteiro e, só se tudo passar, chama `applyConfig` **uma vez**; um erro
  marca o campo (`parseMoney`: `12,50`/`12.50`/`R$`; `parseRechargeDate`:
  `dd/mm`, `dd/mm/aaaa` ou ISO, sem data futura), mantém a modal aberta e foca o
  primeiro inválido. `parseMoney` aceita até **4 casas decimais** (`3,2345`,
  `3.2345`); sem debounce e sem `COST_SPENT_COMMIT_MS`. **Última recarga** usa o
  `DateInput` de `opencode-shared/gui` (classe `os-date`, o kit do host só tem
  `TextInput` de texto): o valor é o dia local em `aaaa-mm-dd`
  (`formatDateValue`), que `parseRechargeDate` já entende; o instante exato do
  prefill de "Repus créditos" é preservado enquanto o campo não é tocado.
  O estado persiste em `src/gui/cost-settings.ts`, um store **global**
  (`ctx.storage.store`) com um registro por provider. O `costSettingsFor` mantém
  uma cópia **autoritativa** em `createSignal` e escreve no store com `set(...)`
  (valor inteiro, não `update` aninhado): o `.value` do store não re-renderizava
  os memos depois de um `update`. A semeadura do store só acontece uma vez,
  quando `ready()` fica verdadeiro, e nunca sobrescreve uma edição feita antes.
  **Última recarga ancora o ciclo:** `start = lastRecharge` (fallback `spentAt`
  legado, depois o início da janela), limitado a `agora − 90 dias` — uma recarga
  mais antiga recorta o eixo e o card avisa "recarga há N dias". `costRanges`
  devolve o eixo começando nele (com o gasto intermediário num `offset` somado
  ao baseline quando o início cai antes da janela). **Já gasto** é o **total
  gasto no ciclo** (no instante da recarga, normalmente 0); sem recarga e sem
  valor anterior, o número digitado é o **total agora** e vira um degrau sobre a
  janela medida — **não** carimba `spentAt = agora`, senão o eixo começaria no
  save e esconderia todo o histórico anterior. Sem o total desenhado à mão (card
  ainda não carregado), cai no comportamento antigo e carimba o marco.
  `applyConfig` decide tudo
  de uma vez: recarga nova (ou alterada) vira `lastRecharge = spentAt = data`, o
  valor digitado vira baseline sem degrau e os ajustes anteriores são podados —
  um campo não editado não carrega o total do ciclo anterior para o novo;
  recarga igual com valor diferente trata o valor digitado como **total
  corrente**: grava **um** ajuste `{ at: agora, delta = digitado − total
  desenhado, seen = total desenhado − ajustes anteriores }` e move `spent` pelo
  mesmo delta, então o baseline do marco não
  muda e o card pousa exatamente no valor digitado; só limite/janela é patch
  direto; limpar **Já gasto** apaga valor, marco e ajustes. **Migração:** um save
  descarta os ajustes gravados antes de `seen` existir (foram calculados contra o
  `spent` armazenado, não contra o total desenhado, e desenhavam degraus que o
  card nunca mostrou); como o fim da série é `spent + medido` com ou sem eles, o
  total não muda e o histórico legado deixa de dobrar a curva.
  A média divide pelo tempo decorrido desde o início do eixo (piso de 1 dia);
  sem marco, pela janela. O cruzamento do limite parte do total corrente
  (`baseline + total + ajustes`) e o fim do eixo vem de `axisEnd`: cruzamento
  + 3 dias (teto de 90) ou, sem cruzamento, hoje + 30 dias. `baselineAtMark` e
  `applyCostAdjustments` mantêm os valores anteriores à edição intactos e
  inserem um degrau no instante do save — inclusive quando o save acontece
  depois do último ponto medido (o degrau é anexado ao fim da série, então a
  edição aparece sem esperar o próximo fetch); a inclinação do forecast continua
  sendo o custo médio **medido** (edições externas não inflam a média). O resumo do
  card (`saldo acaba em ~data`, `não acaba no horizonte`, `limite já atingido`,
  `sem limite`) e o recap dos valores ficam no rodapé, junto da legenda
  Uso/Forecast/Limite. Só criar/limpar/alterar a recarga (mudança de
  `lastRecharge`/`spentAt`) recarrega as fatias; o cache **não** depende do
  baseline.
  **Gateway (opcional):** o `load` chama `gateway({ providerID })` em paralelo
  com as fatias; a resposta nunca derruba o card (uma exceção vira `null` e cai
  no manual). Com `status:"ok"`, `gatewayCycle` (`src/cost.ts`, puro) dobra o
  `gatewayBase`/`gatewayResetAt` guardados no settings: o total desenhado é
  `spend − base`, o limite é `max_budget − base` (ou `max_budget` quando
  `budget_reset_at` mudou ou o spend ficou abaixo da base) e a curva parte de
  `base`. A série é fechada no spend da chave com um degrau no instante do
  fetch, porque o gateway pode incluir gasto que esta máquina não mediu; os
  ajustes manuais são ignorados nesse modo. **Repus créditos** captura o spend
  e o `resetsAt` do gateway como base do ciclo novo (`applyConfig` com
  `gateway`); **Configurar** só move a base quando a recarga muda, e limpar a
  recarga a zera. Com `status:"missingKey"` o manual segue normal; com
  `status:"error"` e `hasKey` o card mostra um aviso discreto (`invalidKey` ou a
  mensagem) e usa o manual. O `onSaved` da modal re-dispara o `load`.
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
  ou janela deslizante 15m/30m/1h), então os rótulos precisam ser reativos.
  O gráfico da janela mantém um clock próprio de 1 Hz (o `now` do painel só
  ticka com `running`), então a janela deslisa mesmo com a sessão ociosa. O
  domínio se adapta às amostras presentes na janela (`windowDomain`), como no
  turno, para que períodos de ociosidade não deixem espaço vazio no eixo X; o
  rótulo do eixo X esquerdo mostra o horário local do início da janela
  (`formatClock`).
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
