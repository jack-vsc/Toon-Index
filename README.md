# Toon Index

Tradutor e biblioteca de mangá, manhwa e webtoon para Windows, escrito em Rust. Baixa capítulos dos
sites, traduz as páginas com um modelo de visão (Claude, GPT, Gemini pelo OpenRouter, ou um modelo
local no Ollama), apaga o texto original e escreve a tradução no balão, com uma fonte parecida com a
do letreiro. Os capítulos ficam numa biblioteca por obra, com o que já foi lido e os capítulos novos
que saíram nos sites.

O projeto tem três partes:

| parte | onde | o que faz |
|---|---|---|
| app do PC | `crates/` (Rust) | traduz, baixa, guarda a biblioteca e atende o celular e a extensão |
| app do celular | `mobile/` (Flutter) | lê a biblioteca, pede capítulos ao PC, lê no navegador do celular |
| extensão | `extension/` (Chrome/Edge/Brave) | anota os capítulos lidos em qualquer site e mostra os novos |

A primeira versão do app do PC, em Electron e TypeScript, está na branch
[`electron`](https://github.com/jack-vsc/Toon-Index/tree/electron). As duas versões usam a mesma pasta
de dados.

## Como a página é traduzida

```
página → faixas → detector de texto → caixas numeradas + chave → modelo → blocos → apagar → escrever
```

1. A página é lida na largura de saída (1400 px; 1000 px nas tiras de webtoon) e cortada em faixas.
   Os cortes caem nos vãos entre os quadros e nunca no meio de um texto.
2. Os blocos de letreiro são achados sem depender do modelo: pelo servidor de visão em Python, quando
   ligado (ver abaixo), ou por um detector próprio (black-hat/top-hat, componentes conexos, letras em
   linhas e linhas em blocos), que também acrescenta o que o servidor deixou escapar.
3. O modelo recebe as faixas com as caixas numeradas em magenta e uma "chave" com cada caixa ampliada,
   e responde em JSON qual caixa tem qual fala, a tradução, o tipo de balão e o estilo da letra.
4. A posição do texto vem das caixas do detector, não da caixa que o modelo inventa. Caixas que o
   modelo esqueceu são perguntadas de novo, sozinhas.
5. As letras originais são apagadas pelo LaMa do servidor de visão (o interior do balão inteiro, e as
   onomatopeias pelo desenho das letras) ou, sem ele, por convolução normalizada (média dos pixels
   lisos em volta). A tradução é escrita no espaço livre do balão, no tamanho do original quando cabe.

As respostas ficam em cache: traduzir de novo a mesma página com o mesmo modelo não custa nada.

## Sites

| site | busca | lista de capítulos | download |
|---|---|---|---|
| MangaDex | API | API | API de imagens |
| mgeko | página | página "all chapters" | navegador |
| MangaKakalot | página | lista da própria página | navegador |
| MangaLivre (português) | página | "carregar mais" até o fim | navegador (sem traduzir) |
| qualquer outro | — | links da página da obra | navegador |

Os sites são lidos por um Edge (ou Chrome) controlado pelo app, com um perfil próprio em
`%APPDATA%\Manga Index\browser-profile`. A janela fica fora da tela; quando o site pede a verificação do
Cloudflare, ela aparece para você confirmar, e o cookie vale para as próximas vezes.

Sites que pedem login entram sozinhos com as contas de `%APPDATA%\Manga Index\site-logins.env`
(botão "Contas dos sites" nas configurações). A senha vai só para o próprio site.

## Instalação

Requer Windows 10 ou 11 com o Edge (já vem no Windows) e o Rust estável (1.85 ou mais novo) com as
ferramentas de C++ do Visual Studio.

```
cargo build --release
target\release\toon-index.exe
```

Na primeira vez, cadastre uma API em Configurações: a URL base (por exemplo
`https://openrouter.ai/api/v1` ou `https://api.anthropic.com/v1`), o modelo e a chave. O botão
"Testar" manda uma imagem de 32 px e diz quanto a API demorou.

### Celular

```
cd mobile
flutter build apk --release
node ../scripts/phone-release.mjs
```

O PC entrega o APK aos celulares pareados, que oferecem a atualização sozinhos. Para parear, ligue
"Atender o celular na rede" na aba Celular e leia o QR no app do celular.

### Extensão

Em `edge://extensions` (ou `chrome://extensions`), ligue o modo de desenvolvedor e carregue a pasta
`extension/`. Ela fala com o app em `http://127.0.0.1:47321`, e só ela: o servidor recusa pedidos de
páginas da web.

## Dados

Tudo fica em `%APPDATA%\Manga Index`, no mesmo formato da versão anterior em Electron, então quem já
usava o app abre a biblioteca como estava:

| arquivo | conteúdo |
|---|---|
| `library/works.json` | as obras, com todos os nomes, listas, favoritas e páginas nos sites |
| `library/<id>/` | um capítulo: `meta.json`, `original.pdf`, `translated.pdf`, `cover.jpg` |
| `library/reading.json` | até onde cada obra foi lida |
| `settings.json` | configurações e as chaves de API, criptografadas pelo Windows (DPAPI) |
| `remote-jobs/jobs.json` | a fila de capítulos |
| `devices.json` | celulares pareados (só o hash do token) |
| `updates.json` | o que cada página de obra tinha na última verificação |
| `translation-cache/` | as respostas dos modelos |
| `training-dataset/` | as páginas traduzidas por modelos Claude, como exemplos de treino |

Nenhum desses arquivos entra no repositório. `TOON_DATA_DIR` aponta o app para outra pasta (testes).

## Organização do código

| crate | conteúdo |
|---|---|
| `toon-core` | dados: obras, nomes de capítulo, biblioteca, leitura, fila, celulares, configurações e chaves |
| `toon-ai` | prompt, leitura tolerante do JSON dos modelos, provedores (OpenAI, Ollama, Anthropic), cache |
| `toon-page` | detector de texto, faixas, marcações, apagar e escrever, fontes, PDFs, capítulo inteiro |
| `toon-web` | navegador controlado pelo app, download de capítulos, logins, busca e listas nos sites |
| `toon-server` | o servidor do celular e da extensão |
| `toon` | o executável: janela em egui, a fila rodando, a verificação de capítulos novos |

Mais detalhes em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

### Servidor de visão (opcional)

Para achar os balões e repintar embaixo do texto, redes treinadas em mangá fazem melhor que qualquer
coisa escrita à mão, e o ecossistema delas é o Python. O app abre `vision/manga_vision.py` como um
programa à parte e conversa com ele por uma linha de JSON por pedido. O script vai junto do executável
e é gravado na pasta de dados ao abrir.

Numa pasta qualquer (por exemplo `D:\vision`):

```
python -m venv .venv
.venv\Scripts\pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121
.venv\Scripts\pip install -r <repositório>\vision\requirements.txt
```

e os modelos em `models\pretrained` dentro dela:

| Arquivo | O que faz | De onde vem |
| --- | --- | --- |
| `comictextdetector.pt.onnx` | blocos, linhas e máscara das letras | manga-image-translator |
| `bubble-seg.pt` | contorno dos balões (YOLOv8) | kitsumed/yolov8m_seg-speech-bubble |
| `anime-manga-big-lama.pt` | LaMa ajustado para mangá | IOPaint |
| `comic-text-and-bubble-detector.onnx` (opcional) | balões que a segmentação perde, texto dentro e fora deles | ogkalu/comic-text-and-bubble-detector |

Depois escolha essa pasta em Configurações › Servidor de visão. Ele liga na primeira página, fecha
depois de cinco minutos parado e roda na placa de vídeo NVIDIA ou no processador. Sem a pasta, sem o
Python ou com o servidor caído, a página segue pelo detector e pelo apagador próprios.

Teste numa imagem: `TOON_VISION_DIR=D:\vision cargo run --release -p toon-page --example vision -- pagina.jpg`
grava ao lado dela a página apagada e a página com um texto de teste escrito.

## Também no app

- **Novels em PDF de texto**: o texto sai da camada de texto do PDF (inclusive os mapas ToUnicode das
  edições da Yen Press e da Kobo), vai para a IA parágrafo por parágrafo e é composto de novo nas
  páginas do mesmo tamanho, com as ilustrações no lugar.
- **Camadas**: cada página traduzida guarda só o que mudou; traduzir o mesmo capítulo de novo põe as
  páginas de volta em segundos, sem a IA. O nome de cada camada vem dos bytes da imagem original no
  PDF, não de como a página é desenhada, e os pedaços se ajustam a outro tamanho de página: outra
  versão do app, em outra linguagem, acha as mesmas camadas. O formato está em
  [docs/CAMADAS.md](docs/CAMADAS.md).
- **Modelo próprio no PC**: o perfil "Neste PC" liga o `llama-server` do llama.cpp com o modelo
  instalado em `local-ai` e desliga depois de cinco minutos sem uso.
- **Ficha da obra** ("Atualizar dados"): nome, sinopse, gêneros, situação, ano e capa pelo MangaDex ou
  pela página da obra; obras novas são procuradas nos sites sozinhas e ganham capa.
- **Histórico dos navegadores**: os capítulos lidos no Chrome, Brave, Opera e Edge viram leitura.
- **Avisos de capítulo novo**: no Windows, no celular pelo Firebase (com a chave da conta de serviço)
  ou pelo ntfy.sh; obras marcadas para "traduzir sozinho" ou "baixar sozinho" entram na fila.
- **Sincronização pela internet**: a mesma conta e o mesmo espaço do Firebase de antes, pela API REST;
  o celular lê a biblioteca e manda pedidos quando não alcança o PC.

## Limites

- Perfis do Cursor não funcionam: o Cursor só tem SDK em Node. Use a mesma conta pelo OpenRouter ou
  pela API da Anthropic.
- As camadas e as respostas guardadas pela versão em Electron continuam no disco, mas não são
  reaproveitadas: o nome de cada uma vinha dos pixels da página como o pdf.js desenhava. Os capítulos
  já traduzidos estão todos na biblioteca; só refazer um deles vai de novo para a IA. As camadas de
  agora em diante não têm esse problema.

## Licença

MIT. As fontes em `assets/fonts` têm licenças próprias (SIL Open Font License e Apache), ao lado de
cada uma.
