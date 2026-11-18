# Toon Index (versão em Electron)

Traduz capítulos de mangá/manhwa em PDF com IA e redesenha o texto traduzido nos balões.

> Esta é a primeira versão do app, em Electron, TypeScript e React, mantida nesta branch para
> consulta. A versão atual é a reescrita em Rust, na branch `main`. As duas usam a mesma pasta de
> dados (`%APPDATA%\Manga Index`), e a versão em Rust lê tudo o que esta gravou. Não abra as duas ao
> mesmo tempo: a fila e a nuvem são as mesmas.

## Rodar

```
npm install
npm run dev
```

O servidor de visão abaixo é opcional. Sem ele, o app usa o detector e o preenchimento internos.

## Modelos de visão (detecção de balões + apagamento)

O app encontra o texto e os balões e apaga o texto original com modelos prontos para mangá, rodados
por `scripts/manga_vision.py` no Python do `.venv` (GPU NVIDIA quando disponível):

| Arquivo em `models/pretrained/` | Uso | Origem |
| --- | --- | --- |
| `comictextdetector.pt.onnx` | blocos, linhas e máscara do texto | [manga-image-translator](https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx) |
| `bubble-seg.pt` | contorno dos balões (YOLOv8-seg) | [kitsumed/yolov8m_seg-speech-bubble](https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble/resolve/main/model.pt) |
| `anime-manga-big-lama.pt` | apagamento (LaMa ajustado para mangá) | [IOPaint](https://github.com/Sanster/models/releases/download/AnimeMangaInpainting/anime-manga-big-lama.pt) |
| `comic-text-and-bubble-detector.onnx` (opcional) | balões que a segmentação perde (translúcidos, de grito) e texto dentro × fora de balão | [ogkalu/comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector.onnx) |

Dependências Python (além de `torch` com CUDA e `ultralytics`): `onnxruntime-gpu==1.22.0` (a 1.22 é a
última para CUDA 12), `opencv-python`, `numpy`.

Teste rápido numa imagem: `.venv/Scripts/python.exe scripts/manga_vision.py --test pagina.jpg pasta-saida`.
Sem o Python ou os modelos, o app volta para o detector e o preenchimento internos.

## Avaliação contra uma tradução feita à mão

```
node scripts/images-to-pdf.mjs <pasta-de-imagens> capitulo.pdf
MI_EVAL_PDF=capitulo.pdf MI_EVAL_REF=<pasta-da-scan> MI_EVAL_OUT=samples/eval/run MI_EVAL_PAGES=1-3 npx electron-vite dev
```

## Licença

MIT. Veja [LICENSE](LICENSE).
