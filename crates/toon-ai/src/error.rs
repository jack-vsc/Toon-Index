use std::sync::LazyLock;

use regex::Regex;
use toon_core::settings::ApiProfile;

/// O que deu errado ao falar com o modelo, já com a mensagem que diz o que fazer.
#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("HTTP {status}: {}", provider_message(body))]
    Http {
        status: u16,
        body: String,
        retry_after: Option<u64>,
    },
    /// O modelo respondeu, mas não no JSON pedido.
    #[error("{0}")]
    Format(String),
    /// A resposta foi cortada no limite de tokens; `partial` é o que veio antes do corte.
    #[error("{message}")]
    Truncated { message: String, partial: String },
    #[error("{0}")]
    Network(String),
    #[error("Cancelado pelo usuário.")]
    Cancelled,
    /// Já explicada para a pessoa.
    #[error("{message}")]
    App {
        code: &'static str,
        message: String,
        detail: Option<String>,
    },
}

impl AiError {
    pub fn app(code: &'static str, message: impl Into<String>) -> Self {
        AiError::App {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn is_format(&self) -> bool {
        matches!(self, AiError::Format(_) | AiError::Truncated { .. })
    }

    pub fn code(&self) -> &'static str {
        match self {
            AiError::App { code, .. } => code,
            AiError::Format(_) | AiError::Truncated { .. } => "format",
            AiError::Cancelled => "cancelled",
            _ => "unknown",
        }
    }
}

/// A mensagem que o provedor pôs no corpo do erro, quando é JSON.
fn provider_message(body: &str) -> String {
    let from_json = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("message"))
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str().map(str::to_string))
        });
    from_json.unwrap_or_else(|| body.chars().take(300).collect())
}

macro_rules! pattern {
    ($name:ident, $re:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($re).unwrap());
    };
}

pattern!(
    QUOTA,
    r"(?i)out of usage|usage limit|increase (your )?limits?|spend(ing)? limit|insufficient_quota|exceeded your current quota|quota exceeded|free-models-per-day"
);
pattern!(
    CREDITS,
    r"(?i)insufficient (credits|balance|funds)|more credits|can only afford|payment required|credit balance"
);
pattern!(
    BLOCKED,
    r"(?i)flagged|moderation|content[_ ](policy|filter)|safety|prohibited[_ ]content"
);
pattern!(
    AUTH,
    r"(?i)unauthori[sz]ed|invalid.{0,10}api.?key|incorrect api key|no auth credentials|authentication|permission denied"
);
pattern!(
    VISION,
    r"(?i)image input|support(s)? images?|vision|image_url|multimodal"
);
pattern!(
    MODEL,
    r"(?i)model.{0,40}(not found|does not exist|is not a valid|invalid|unknown|not available)|no endpoints found|not a valid model"
);
pattern!(
    RATE,
    r"(?i)rate.?limit|too many requests|resource.?exhausted"
);
pattern!(
    SERVER,
    r"(?i)overloaded|unavailable|bad gateway|timed? ?out|internal server error"
);
pattern!(
    NETWORK,
    r"(?i)error sending request|dns|connection refused|connection reset|timed out|network"
);

/// Transforma o que o provedor devolveu numa mensagem que diz o que aconteceu e o que fazer.
pub fn describe(err: AiError, profile: &ApiProfile) -> AiError {
    if matches!(err, AiError::App { .. } | AiError::Cancelled) {
        return err;
    }
    let detail = err.to_string();
    let status = if let AiError::Http { status, .. } = err {
        Some(status)
    } else {
        None
    };
    let is = |p: &Regex| p.is_match(&detail);
    let api = format!("\"{}\"", profile.name);
    let model = format!("\"{}\"", profile.model);
    let (code, message) = if err.is_format() {
        (
            "format",
            "A IA respondeu fora do formato esperado. Tente de novo; se repetir, use outro modelo."
                .to_string(),
        )
    } else if is(&QUOTA) {
        (
            "quota",
            format!(
                "A cota da API {api} acabou. Troque de API nas configurações ou aumente o limite da conta."
            ),
        )
    } else if status == Some(402) || is(&CREDITS) {
        (
            "credits",
            format!(
                "Sem créditos na API {api}. Adicione créditos no site do provedor ou troque de API."
            ),
        )
    } else if is(&BLOCKED) {
        (
            "blocked",
            "O provedor recusou esta página pela política de conteúdo. Tente outro modelo."
                .to_string(),
        )
    } else if matches!(status, Some(401 | 403)) || is(&AUTH) {
        (
            "auth",
            format!(
                "A chave da API {api} foi recusada (inválida, revogada ou sem permissão). Confira a chave nas configurações."
            ),
        )
    } else if is(&VISION) {
        (
            "vision",
            format!("O modelo {model} não aceita imagens. Escolha um modelo com visão."),
        )
    } else if status == Some(404) || is(&MODEL) {
        (
            "model",
            format!(
                "O modelo {model} não existe na API {api} ou não está liberado para sua conta. Confira o ID do modelo."
            ),
        )
    } else if status == Some(429) || is(&RATE) {
        ("rate", "Limite de requisições atingido. Espere um pouco e tente de novo, ou diminua \"Páginas ao mesmo tempo\".".to_string())
    } else if status.is_some_and(|s| s >= 500) || is(&SERVER) {
        (
            "server",
            "O servidor da API falhou ou está sobrecarregado. Tente de novo em instantes."
                .to_string(),
        )
    } else if matches!(err, AiError::Network(_)) || is(&NETWORK) {
        if profile.is_local() {
            (
                "network",
                format!(
                    "Nada respondendo em {}. Abra o Ollama (ou o servidor local) e tente de novo.",
                    profile.base_url
                ),
            )
        } else {
            (
                "network",
                "Sem conexão com a API. Confira a internet e tente de novo.".to_string(),
            )
        }
    } else {
        (
            "unknown",
            format!(
                "Falha na API {api}: {}",
                detail.chars().take(200).collect::<String>()
            ),
        )
    };
    AiError::App {
        code,
        message,
        detail: Some(detail),
    }
}
