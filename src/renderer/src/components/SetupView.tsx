import { useState } from "react";
import {
  activeProfile,
  isLocalProfile,
  profileReady,
  type AiDevice,
  type GpuSharing,
  type PublicSettings,
  type Speed,
  type TranslateOptions,
} from "../../../shared/types";
import { LanguageSelect } from "./LanguageSelect";

export type RunOptions = TranslateOptions;

export interface SetupChoice {
  /** Pages of the output, in order. */
  pages: number[];
  /** Subset of `pages` kept as they are (scanlator credit pages). */
  untranslated: number[];
  options: RunOptions;
  /** A novel: its text read from the PDF and set again, instead of the comic's vision and lettering. */
  novel: boolean;
}

interface Props {
  fileName: string;
  numPages: number;
  cover: string | null;
  /** The PDF looks like a novel (most pages have a text layer): the type it starts on. */
  detectedNovel: boolean;
  settings: PublicSettings;
  onStart: (choice: SetupChoice) => void;
  onCancel: () => void;
  onProfileChange: (profileId: string) => void;
  onOpenSettings: () => void;
}

export const GPU_LABEL: Record<GpuSharing, string> = {
  auto: "Automático (separa com modelo local em GPU pequena)",
  phased: "Em fila, uma IA de cada vez (GPU com pouca memória, como 2 GB)",
  together: "Tudo junto, página por página (GPU com bastante memória)",
};

const SPEED_LABEL: Record<Speed, string> = {
  fast: "Rápido (raciocínio baixo)",
  balanced: "Equilibrado",
  quality: "Qualidade máxima (mais lento)",
};

export function SetupView({
  fileName,
  numPages,
  cover,
  detectedNovel,
  settings,
  onStart,
  onCancel,
  onProfileChange,
  onOpenSettings,
}: Props) {
  const [draft, setDraft] = useState<Omit<RunOptions, "activeProfileId">>(
    () => ({
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      concurrency: settings.concurrency,
      speed: settings.speed,
      translateSfx: settings.translateSfx,
      reuseLayers: settings.reuseLayers,
    contentType: settings.contentType,
      skipStart: settings.skipStart,
      skipEnd: settings.skipEnd,
      gpuSharing: settings.gpuSharing,
      visionDevice: settings.visionDevice,
      aiDevice: settings.aiDevice,
    }),
  );
  const [mode, setMode] = useState<"all" | "range">("all");
  const [novel, setNovel] = useState(detectedNovel);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(numPages);

  const patch = (p: Partial<Omit<RunOptions, "activeProfileId">>) =>
    setDraft((d) => ({ ...d, ...p }));
  const first = clamp(Math.min(from, to), 1, numPages);
  const last = clamp(Math.max(from, to), 1, numPages);
  // Always leave at least one page to translate.
  const skipStart = clamp(draft.skipStart, 0, numPages - 1);
  const skipEnd = clamp(draft.skipEnd, 0, numPages - 1 - skipStart);
  const count =
    mode === "all" ? numPages - skipStart - skipEnd : last - first + 1;
  const profile = activeProfile(settings);
  const ready = profileReady(profile, settings.hasKey);

  function start() {
    // The API as picked above (saved at once when changed).
    const options = { ...draft, activeProfileId: settings.activeProfileId };
    if (mode === "all") {
      const pages = Array.from({ length: numPages }, (_, i) => i + 1);
      const untranslated = pages.filter(
        (n) => n <= skipStart || n > numPages - skipEnd,
      );
      onStart({
        pages,
        untranslated,
        options: { ...options, skipStart, skipEnd },
        novel,
      });
    } else {
      const pages = Array.from(
        { length: last - first + 1 },
        (_, i) => first + i,
      );
      onStart({ pages, untranslated: [], options, novel });
    }
  }

  return (
    <div className="setup">
      <div className="setup-cover">
        {cover ? <img src={cover} alt="Capa" /> : <span className="spinner" />}
      </div>
      <div className="setup-form">
        <h2>{fileName}</h2>
        <p className="hint">{numPages} páginas no PDF</p>

        <section>
          <label className="field-label">Tipo</label>
          <div className="segmented">
            <button
              className={!novel ? "active" : ""}
              onClick={() => setNovel(false)}
            >
              Mangá / webtoon
            </button>
            <button
              className={novel ? "active" : ""}
              onClick={() => setNovel(true)}
            >
              Novel (texto)
            </button>
          </div>
          <p className="hint">
            {novel
              ? "Lê o texto do próprio PDF, traduz parágrafo por parágrafo e monta as páginas de novo com o texto traduzido, sem a visão. As ilustrações ficam como estão."
              : "Acha os balões nas imagens, traduz e redesenha o texto por cima."}
            {detectedNovel !== novel &&
              (detectedNovel
                ? " Este PDF parece uma novel: quase todas as páginas têm texto."
                : " Este PDF não tem texto selecionável na maioria das páginas: o modo novel só serve para PDFs com texto.")}
          </p>
        </section>

        <section>
          <label className="field-label">O que traduzir</label>
          <div className="segmented">
            <button
              className={mode === "all" ? "active" : ""}
              onClick={() => setMode("all")}
            >
              PDF inteiro
            </button>
            <button
              className={mode === "range" ? "active" : ""}
              onClick={() => setMode("range")}
            >
              Intervalo de páginas
            </button>
          </div>
          {mode === "all" && (
            <>
              <div className="row range">
                <span>Não traduzir as primeiras</span>
                <input
                  type="number"
                  min={0}
                  max={numPages - 1}
                  value={skipStart}
                  onChange={(e) =>
                    patch({
                      skipStart: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                />
                <span>e as últimas</span>
                <input
                  type="number"
                  min={0}
                  max={numPages - 1}
                  value={skipEnd}
                  onChange={(e) =>
                    patch({ skipEnd: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
                <span>páginas</span>
              </div>
              <p className="hint">
                Útil para pular as páginas de aviso da scan. Elas continuam no
                PDF, só não são traduzidas.
                {(skipStart > 0 || skipEnd > 0) &&
                  ` Traduzindo da página ${skipStart + 1} à ${numPages - skipEnd}.`}
              </p>
            </>
          )}
          {mode === "range" && (
            <div className="row range">
              <span>Da página</span>
              <input
                type="number"
                min={1}
                max={numPages}
                value={from}
                onChange={(e) => setFrom(Number(e.target.value) || 1)}
              />
              <span>até</span>
              <input
                type="number"
                min={1}
                max={numPages}
                value={to}
                onChange={(e) => setTo(Number(e.target.value) || 1)}
              />
            </div>
          )}
        </section>

        <section className="grid-2">
          <div>
            <label className="field-label">Idioma original</label>
            <LanguageSelect
              allowAuto
              value={draft.sourceLanguage}
              onChange={(sourceLanguage) => patch({ sourceLanguage })}
            />
          </div>
          <div>
            <label className="field-label">Traduzir para</label>
            <LanguageSelect
              value={draft.targetLanguage}
              onChange={(targetLanguage) => patch({ targetLanguage })}
            />
          </div>
        </section>

        <section className="grid-2">
          <div>
            <label className="field-label">
              {novel ? "Pedidos à IA ao mesmo tempo" : "Páginas ao mesmo tempo"}
            </label>
            <select
              value={draft.concurrency}
              onChange={(e) => patch({ concurrency: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Velocidade</label>
            <select
              value={draft.speed}
              onChange={(e) => patch({ speed: e.target.value as Speed })}
            >
              {(Object.keys(SPEED_LABEL) as Speed[]).map((s) => (
                <option key={s} value={s}>
                  {SPEED_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </section>

        {!novel && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.translateSfx}
                onChange={(e) => patch({ translateSfx: e.target.checked })}
              />
              Traduzir onomatopeias
            </label>
            <label
              className="checkbox"
              title="Desligue para traduzir de novo do zero (com outro modelo, por exemplo)"
            >
              <input
                type="checkbox"
                checked={draft.reuseLayers}
                onChange={(e) => patch({ reuseLayers: e.target.checked })}
              />
              Reaproveitar páginas já traduzidas antes
            </label>

            <section>
              <label className="field-label">Uso da GPU</label>
              <select
                value={draft.gpuSharing}
                onChange={(e) =>
                  patch({ gpuSharing: e.target.value as GpuSharing })
                }
              >
                {(Object.keys(GPU_LABEL) as GpuSharing[]).map((g) => (
                  <option key={g} value={g}>
                    {GPU_LABEL[g]}
                  </option>
                ))}
              </select>
              <p className="hint">
                Uma de cada vez: detecta o capítulo todo, depois traduz, depois
                redesenha, liberando a GPU entre as etapas. Deixa modelos locais
                bem mais rápidos em placas de até 8 GB.
              </p>
            </section>

            <section className="grid-2">
              <div>
                <label className="field-label">
                  Visão (achar e apagar o texto) em
                </label>
                <select
                  value={draft.visionDevice}
                  onChange={(e) =>
                    patch({ visionDevice: e.target.value as AiDevice })
                  }
                >
                  <option value="gpu">Placa de vídeo (GPU)</option>
                  <option value="cpu">Processador (deixa a GPU livre)</option>
                </select>
              </div>
              {profile && isLocalProfile(profile) && (
                <div>
                  <label className="field-label">
                    Modelo de tradução local em
                  </label>
                  <select
                    value={draft.aiDevice}
                    onChange={(e) =>
                      patch({ aiDevice: e.target.value as AiDevice })
                    }
                  >
                    <option value="gpu">Placa de vídeo (GPU)</option>
                    <option value="cpu">Processador e RAM</option>
                  </select>
                </div>
              )}
            </section>
            {draft.visionDevice === "cpu" && (
              <p className="hint">
                No processador cada página leva minutos em vez de segundos, mas
                a placa fica livre para outra coisa.
              </p>
            )}
          </>
        )}

        <section>
          <label className="field-label">API</label>
          <div className="row">
            <select
              value={profile?.id ?? ""}
              onChange={(e) => onProfileChange(e.target.value)}
            >
              {settings.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model || "sem modelo"}
                  {settings.hasKey[p.id] || isLocalProfile(p)
                    ? ""
                    : " (sem chave)"}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={onOpenSettings}>
              Gerenciar APIs
            </button>
          </div>
          {!ready && (
            <p className="error">
              Essa API está sem chave ou sem modelo. Configure em "Gerenciar
              APIs".
            </p>
          )}
        </section>

        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button onClick={start} disabled={!ready}>
            Traduzir {count} {count === 1 ? "página" : "páginas"}
          </button>
        </div>
      </div>
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
