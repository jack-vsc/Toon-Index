# Camadas de tradução

Cada página traduzida é guardada em `%APPDATA%\Manga Index\translation-layers\<chave>.json` só com o
que a tradução mudou nela. Refazer um capítulo põe as páginas de volta daqui, sem a IA.

O formato não depende da linguagem nem de como a página é desenhada. Qualquer versão do app, em
qualquer linguagem, que siga este documento acha e usa as mesmas camadas.

## A impressão digital da página

`source` é o SHA-256, em hexadecimal minúsculo, dos bytes da imagem original como estão guardados:

- **Página de PDF com JPEG** (filtro `DCTDecode`): os bytes do stream da imagem, sem decodificar.
- **Página de PDF com outra imagem**: as amostras descompactadas do stream (depois do `FlateDecode`),
  sem converter cor nem tamanho.
- **Capítulo baixado como imagens**: os bytes do arquivo baixado.

Em cada página do PDF vale a maior imagem que ela desenha. Os bytes de um JPEG são os mesmos em
qualquer leitor de PDF. O resultado de decodificar não é, e foi por isso que as camadas da versão em
Electron, nomeadas pelos pixels que o pdf.js desenhava, não puderam ser reaproveitadas.

## A chave

```
chave = sha256_hex("toon-layer/2|" + tag + "|" + source)
```

`tag` são as opções que mudam o resultado da tradução: `"<idioma de destino>|sfx:<true|false>"`, por
exemplo `Brazilian Portuguese|sfx:false`.

## O arquivo

```json
{
  "format": 2,
  "source": "9f2c…",
  "tag": "Brazilian Portuguese|sfx:false",
  "width": 1400,
  "height": 2007,
  "blockCount": 7,
  "patches": [{ "x": 168, "y": 144, "webp": "UklGR…" }]
}
```

- `width` e `height`: o tamanho da página em que os pedaços foram tirados.
- `patches`: os retângulos que mudaram, em pixels dessa página, cada um em WebP sem perda e em
  base64.

## Aplicar

Desenhe a página original no tamanho que for. Se o tamanho for outro, mas na mesma proporção (até 1%
de diferença), multiplique a posição e o tamanho de cada pedaço pela escala e redimensione o pedaço.
Se a proporção não bater, a camada não serve: traduza a página de novo.

Arquivos sem `format` são da primeira versão do app em Rust, nomeados pelos pixels da página, e
são ignorados.
