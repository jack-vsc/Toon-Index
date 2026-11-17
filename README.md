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

## Como a página é traduzida

```
página → faixas → detector de texto → caixas numeradas + chave → modelo → blocos → apagar → escrever
```

1. A página é lida na largura de saída (1400 px; 1000 px nas tiras de webtoon) e cortada em faixas.
   Os cortes caem nos vãos entre os quadros e nunca no meio de um texto.
2. Um detector próprio (black-hat/top-hat, componentes conexos, letras em linhas e linhas em blocos)
   acha os blocos de letreiro sem depender do modelo.
3. O modelo recebe as faixas com as caixas numeradas em magenta e uma "chave" com cada caixa ampliada,
   e responde em JSON qual caixa tem qual fala, a tradução, o tipo de balão e o estilo da letra.
4. A posição do texto vem das caixas do detector, não da caixa que o modelo inventa. Caixas que o
   modelo esqueceu são perguntadas de novo, sozinhas.
5. As letras originais são apagadas por convolução normalizada (média dos pixels lisos em volta) e a
   tradução é escrita no espaço livre do balão, no tamanho do original quando cabe.

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

## Limites

Esta versão ainda não tem tudo o que a versão em Electron tinha:

- perfis do Cursor (o SDK dele só existe em Node);
- novels em PDF de texto e PDFs sem imagem por página;
- os modelos de visão locais (detecção de balão e LaMa) e o modelo de tradução local próprio;
- a sincronização pela internet (Firebase) e as notificações de capítulo novo no celular;
- reaproveitar as camadas de páginas já traduzidas, a importação do histórico dos navegadores, a busca
  nos sites próprios e a ficha da obra ("Atualizar dados").

## Licença

MIT. As fontes em `assets/fonts` têm licenças próprias (SIL Open Font License e Apache), ao lado de
cada uma.
