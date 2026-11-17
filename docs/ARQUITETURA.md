# Arquitetura

## Processo e threads

O executável abre a janela (egui, na thread principal) e um runtime tokio com três tarefas:

- **fila** (`toon/src/engine.rs`, `run_queue`): pega o próximo pedido de `remote-jobs/jobs.json`, baixa
  ou lê o PDF, traduz e salva na biblioteca. Um pedido de cada vez; dentro dele, várias páginas ao
  mesmo tempo ("Páginas ao mesmo tempo" nas configurações).
- **capítulos novos** (`check_loop`): a cada três horas lê a lista de capítulos de cada página de obra
  conhecida e grava o maior capítulo em `updates.json`.
- **servidor** (`toon-server`): porta 47321, para o celular e a extensão.

A janela não fala com essas tarefas por canais: os dados estão em arquivos, e um sinal "sujo" no
`Engine` faz a janela ler de novo quando algo muda por fora.

## Uma página

`toon-page/src/page.rs` faz o caminho inteiro:

1. `render`: a imagem da página na largura de saída.
2. `prepare_slices`: o detector roda uma vez na página inteira só para saber onde há texto
   (`text_rows`); os cortes das faixas evitam essas linhas. Depois roda de novo em cada faixa, já na
   resolução mandada ao modelo, e textos achados nas duas sobras ficam com a caixa mais completa
   (`box_once`).
3. `marked_request`: as faixas com as caixas numeradas e a chave (`marks.rs`).
4. `toon_ai::Ready::translate_page`: o pedido ao modelo, com cache e repescagem.
5. `dedupe`: faixas sobrepostas devolvem o mesmo balão duas vezes; fica a cópia mais completa.
6. `overlay::draw_overlay`: acha as letras de cada bloco na página intacta, apaga todas e só então
   escreve as traduções.

### Detector (`detect.rs`)

Fechamento menos a imagem (texto escuro) e a imagem menos a abertura (texto claro) isolam traços finos
sobre qualquer fundo liso. Os componentes fortes que parecem letra (tamanho, proporção, densidade,
fundo liso em volta, não ser a ponta de algo maior) viram linhas quando estão lado a lado com alturas
parecidas, e linhas viram blocos quando estão empilhadas e alinhadas. Blocos de um mesmo balão que
ficaram separados se juntam quando o fundo liga um ao outro sem cruzar uma borda.

### Apagar e escrever (`overlay.rs`)

As letras de um bloco são as que o detector marcou nas caixas que o modelo escolheu. Quando o texto
original tem bem mais letras do que essas caixas (uma narração de letras grandes em que o detector só
pegou uma linha), as linhas logo acima e abaixo entram também.

O preenchimento é uma convolução normalizada: cada pixel apagado vira a média dos pixels lisos num
quadrado em volta, alargado até achar fundo bastante; o miolo de blocos grandes cresce a partir dos
vizinhos já preenchidos. Depois um borrão leve esconde a emenda.

O espaço da tradução é medido depois de apagar, linha por linha, a partir do centro do texto até
onde vai a cor do fundo. O tamanho da fonte é o maior que cabe (busca binária), começando pelo tamanho
das letras originais.

## Modelos (`toon-ai`)

`prompt.rs` monta o pedido e lê a resposta. A leitura tolera o JSON que os modelos escrevem
(`json.rs`: aspas sem escape, vírgulas faltando, fim cortado) e corrige números de caixa deslocados
quando o modelo perde a conta no meio da página (`realign_ids`).

`providers.rs` fala com três APIs:

- formato OpenAI (`/chat/completions`): OpenAI, OpenRouter, LM Studio, llama.cpp, Ollama;
- API do Ollama (`/api/chat`) quando o modelo local roda no processador;
- API de mensagens da Anthropic, chamada direto (não há SDK oficial em Rust).

Erros de quota, crédito, chave, modelo e rede viram mensagens que dizem o que fazer (`error.rs`).

## Sites (`toon-web`)

`browser.rs` abre o Edge com `--remote-debugging-port=0` e um perfil próprio, e conecta pelo arquivo
`DevToolsActivePort`. Se o navegador do app já está aberto, reaproveita. A janela fica em
`-32000,-32000`; quando uma página continua na verificação do Cloudflare depois de alguns segundos, a
janela vem para a tela.

`download.rs` lê um capítulo: espera o leitor montar as páginas, volta ao topo (leitores que lembram
onde o capítulo parou abrem no fim), rola coletando as imagens a cada passo (leitores que só mantêm
as páginas perto da tela) e baixa cada uma com os cookies e os cabeçalhos que o `<img>` do leitor
mandaria. Imagens recusadas assim são pedidas de dentro da própria página.

## Compatibilidade

Os JSONs guardam campos que esta versão não conhece (`#[serde(flatten)] extra`), para não apagar
nada que o celular ou uma versão futura escreva. As chaves de API são lidas no formato do
`safeStorage` do Electron (`v10` + AES-256-GCM, com a chave protegida pelo DPAPI no `Local State`).
