# opencode-stats

Plugin do [OpenCode](https://opencode.ai) (V2) que mostra, na UI do app
desktop, o desempenho da sessão e o **system prompt** que o modelo recebeu.

Duas abas no painel lateral:

- **Estatísticas** — gauge de tok/s, histórico em gráfico de linha, métricas do
  turno e totais da sessão (tempo médio de resposta, reasoning, tool calls,
  tokens e custo).
- **System prompt** — o prompt fixo, o adicionado (AGENTS.md) e o adicionado
  dinamicamente (notes, memory, plans e entradas `api/*`), com filtros, cópia e
  salvamento em `.md`.

Além disso, uma faixa compacta no cabeçalho da sessão mostra o tok/s atual, a
duração, o reasoning e a quantidade de tool calls do último turno.

Um botão **Parar/Iniciar** (ícone play/stop) na aba Estatísticas **liga e
desliga a observabilidade** de todo o processo: com ela desligada, a captura do
prompt e a amostragem de tok/s param, a faixa do cabeçalho some e as duas abas
mostram um estado desativado com a ação de reativar. O estado fica no
`ctx.storage` do servidor (chave `observability`), então sobrevive a reinícios e
hot reloads.

O plugin é autocontido: só usa `@opencode/plugin`, `effect` e `solid-js`, e não
grava nada no repositório. O prompt capturado fica **em memória** no processo do
servidor; não há banco novo.

## Instalação

```bash
git clone git@github.com:HitalloExiled/opencode-stats.git
cd opencode-stats
npm install --legacy-peer-deps
npm run gui:build
mkdir -p ~/.config/opencode/plugins
ln -sfn "$PWD" ~/.config/opencode/plugins/stats
```

> `--legacy-peer-deps` porque `@opencode/plugin` declara um peer opcional de
> vite >= 6 enquanto o build usa vite 5.

Reinicie o OpenCode (ou aguarde o hot-reload). O repo `opencode-tools` consome
este projeto como **git submodule** em `plugins/stats`; o `setup.sh` faz o
symlink, instala as dependências e compila o bundle da GUI.

## O que aparece

### Aba Estatísticas

- **Gauge de tok/s**: valor atual com `~` enquanto o turno está em andamento
  (inclusive entre passos, durante ferramentas) e sem `~` quando a sessão fica
  ociosa. Durante a transmissão o valor é estimado; ao terminar cada passo, o
  exato substitui a estimativa. A média da sessão fica marcada no arco.
- **Escala adaptativa**: piso de 40 tok/s e degraus redondos (40, 60, 80, 100,
  120, 160, 200...). A escala só cresce durante a sessão, então o arco não pula
  a cada amostra.
- **Histórico**: gráfico de linha + área com toggle **Turno | Sessão**. No
  turno, os últimos 60s são amostrados a 1 Hz; na sessão, um ponto exato por
  passo concluído. A média aparece como linha tracejada.
- **Turno atual**: duração, output, 1º token, reasoning (tokens, tempo e
  participação no output) e tool calls com status, duração e argumento resumido.
- **Sessão**: turnos, passos, tempo médio por resposta e por turno, tok/s
  médio/máximo, composição de tokens (input, ferramentas estimadas, output,
  reasoning e cache), custo, taxa de sucesso e ranking de ferramentas, além de
  passos/tokens por modelo.

O tok/s usa a mesma fórmula do rodapé do TUI: `(output + reasoning) /
(streamed - created)` por passo, agregado antes de dividir. O tempo de
ferramenta e as pausas de raciocínio ficam fora da conta.

### Aba System prompt

- **Fixo**: prompt base do OpenCode (ou do agente) + `core/codemode`,
  `core/mcp-guidance`, `core/reference-guidance`, `core/skill-guidance`,
  `core/date` e `core/environment`.
- **Adicionado**: `core/instructions` (AGENTS.md e instruções globais/projeto).
- **Dinâmico**: entradas `api/*` de `session.instructions.entry` e blocos
  injetados por plugins (`<notes-context>`, `<memory-context>`,
  `<plans-context>`, `<plans-plugin>` e regras de roteamento).
- Filtro por grupo, busca, visão por fonte ou texto completo, cópia por parte e
  "copiar tudo"/"salvar .md".
- O cabeçalho mostra agente, modelo, tamanho total, número de partes, horário da
  captura e contador de requests.
- Antes do primeiro request da sessão a aba mostra um estado vazio explicando
  que a captura acontece no próximo request.
- Com a observabilidade desligada, a aba mostra o estado desativado e um botão
  para reativar; nenhuma RPC de prompt é chamada.

### Faixa do cabeçalho

`⚡ ~27.4 tok/s · 🕐 18.6s · 🧠 1.2k · 🔧 7 tools`, com um pulso enquanto o
turno está em andamento (inclusive durante ferramentas). O valor exato
substitui a estimativa quando cada passo termina; o `~` só some quando a sessão
fica ociosa. Clicar abre a aba
Estatísticas. A faixa não aparece em sessões sem passos do assistente nem com a
observabilidade desligada.

## Atalhos e comandos

- `mod+shift+s` — abrir Estatísticas.
- `mod+shift+i` — abrir System prompt.
- Menu do painel da sessão — entradas **Estatísticas**, **System prompt** e
  **Ativar/Desativar observabilidade**.
- Paleta de comandos — **Ativar/Desativar observabilidade** (mostra um toast com
  o novo estado).

## Como funciona

O plugin tem duas partes:

- **Servidor** (`index.ts`): registra o hook `session.context` e captura o
  array `system` montado para o request. A segunda parte normalmente carrega
  `metadata.experimental.instructions`, com uma entrada `{ key, text }` por
  fonte; os plugins `notes`, `memory` e `plans` acrescentam partes extras
  depois. O hook **não** classifica nem faz hash: ele tira um snapshot raso do
  array e enfileira no scheduler; a classificação, a contagem de bytes e o
  SHA-256 rodam no próximo tick (`setImmediate`), fora do caminho do request.
  O scheduler junta por sessão (a captura mais recente vence) e registra
  coalescência, lag e tempo de processamento. A última captura de cada sessão
  fica em memória (hash, agente, modelo, `capturedAt` e contador de requests) e
  é servida pela RPC `systemPrompt`, que aceita `ifNoneMatch` para não reenviar
  o payload quando o hash não mudou.
- **GUI** (`src/gui.tsx`): calcula métricas e histórico a partir de
  `session.server.data` e desenha o gauge/gráfico em SVG, sem biblioteca de
  charts. O histórico da sessão vem de `session.context` (o histórico ativo,
  depois da última compactação), mesclado com a janela viva da timeline.

Store, scheduler e chave de observabilidade são **globais ao processo**
(`globalThis.__opencodeStatsRuntime__`), não recriados a cada `setup`: um hot
reload mantém uma fila e um interruptor só. O teardown descarta as assinaturas,
mas não limpa o store; apenas desligar a observabilidade limpa.

## Dados e privacidade

- Nenhum banco novo, nenhum arquivo no repositório.
- A única coisa persistida é o booleano da observabilidade no `ctx.storage` do
  plugin (chave `observability`), o mesmo mecanismo usado pelo `plans` para o
  locale. As capturas e as séries continuam só em memória.
- A captura do prompt fica só no processo do servidor, em um store global ao
  processo (sobrevive ao hot reload do plugin), e é perdida ao reiniciar; o
  próximo request recaptura.
- Copiar e salvar são ações explícitas do usuário. "Salvar .md" usa o diálogo do
  app e grava onde o usuário escolher.

## Limitações (v0)

- Não inclui subagentes nos totais.
- Os totais da sessão cobrem o **histórico ativo** (mensagens depois da última
  compactação), não o arquivo inteiro.
- A captura vê o `system` no momento em que o hook roda. Como o `stats` é
  carregado depois de `memory`, `notes` e `plans` (ordem alfabética), os blocos
  deles entram; um plugin carregado depois do `stats` pode ficar sem rótulo.
- Sem diff entre capturas e sem persistência das séries entre reinícios.
- tok/s ao vivo é uma estimativa por caracteres ÷ 4; o valor exato substitui a
  estimativa ao concluir o passo. O `~` acompanha o turno inteiro (some só ao
  ficar ocioso) para não piscar a cada passo.
- O segmento **ferramentas** da composição de tokens é uma estimativa pelos
  caracteres do conteúdo retornado pelas tools (÷ 4), descontada do input para
  não contar os mesmos tokens duas vezes. O provider não reporta tokens de
  ferramenta separadamente.
- A leitura do interruptor no `ctx.storage` é assíncrona. Um request que chegue
  antes da hidratação pode ser capturado mesmo com o estado persistido em
  `false`; ao ler `false`, o plugin limpa as capturas e a fila.
- Capturas da mesma sessão enfileiradas no mesmo tick são coalescidas (a mais
  recente vence). O painel mostra sempre a última.

## Estrutura

```text
index.ts                 # servidor: hook de contexto + RPC
src/
  capture.ts             # store em memória + dedupe/LRU
  prompt.ts              # classificação do system prompt (puro)
  rpc.ts                 # handlers RPC
  scheduler.ts           # fila adiada e coalescida da captura
  observability.ts       # interruptor em memória + ctx.storage
  runtime.ts             # store/scheduler/observability globais
  metrics.ts             # turnos, tok/s, durações, reasoning, tools, totais
  history.ts             # ring buffer, escala, paths do gráfico (puro)
  format.ts              # duração, tokens, taxa, bytes
  gui.tsx                # entrada ./gui-experimental
  gui/
    contract.ts          # RPC compartilhada
    setup.tsx            # painel de duas abas + comandos + menu
    stats.tsx            # aba Estatísticas
    prompt.tsx           # aba System prompt
    observability.ts     # estado compartilhado do interruptor
    gauge.tsx            # gauge SVG
    chart.tsx            # gráfico de linha SVG
    header.tsx           # faixa do cabeçalho
    i18n.ts              # PT-BR + EN-US (fallback EN-US)
test/                    # bun test das funções puras
```

## Desenvolvimento

```bash
npm install --legacy-peer-deps
npm run typecheck          # servidor (index.ts + src/**/*.ts)
npm run typecheck:gui      # GUI (tsconfig.gui.json)
npm run gui:build          # dist/gui-experimental.cjs
npm run gui:watch          # rebuild contínuo
bun test test
```

O `dist/` é ignorado pelo git; o `setup.sh` do `opencode-tools` compila o bundle
em cada máquina.
