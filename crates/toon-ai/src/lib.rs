//! Tradução por IA: o prompt das páginas, os provedores (formato OpenAI, Ollama e Anthropic), o
//! cache das respostas e o conjunto de treino que sai delas.

pub mod cancel;
pub mod dataset;
pub mod error;
pub mod json;
pub mod prompt;
pub mod providers;
pub mod translate;
pub mod types;

pub use cancel::Cancel;
pub use error::AiError;
pub use translate::{Ready, ready, test_api};
pub use types::*;
