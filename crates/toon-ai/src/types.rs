use serde::{Deserialize, Serialize};

/// `[x0, y0, x1, y1]` em pixels da imagem mandada ao modelo.
pub type Box = [f32; 4];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    #[default]
    Speech,
    Thought,
    Shout,
    Whisper,
    Narration,
    System,
    Aside,
    Signage,
    Sfx,
    Watermark,
    Other,
}

impl BlockKind {
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(text.to_string())).ok()
    }
}

/// A família da letra original, como os grupos de scan classificam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontRole {
    Comic,
    Brush,
    Condensed,
    Sans,
    Serif,
    Handwritten,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    /// Cobre as letras originais; é o que se pinta por cima.
    pub text_box: Box,
    /// O espaço livre para a tradução (o miolo do balão). Sempre contém `text_box`.
    pub area_box: Box,
    /// As caixas que o detector desenhou em volta das letras deste bloco: tudo nelas é apagado.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ink_boxes: Option<Vec<Box>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_height: Option<f32>,
    pub original: String,
    pub translation: String,
    pub kind: BlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<FontRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    /// '#rrggbb' do preenchimento e do contorno das letras originais.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageImage {
    pub base64: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

impl PageImage {
    pub fn jpeg(bytes: &[u8], width: u32, height: u32) -> Self {
        use base64::Engine;
        PageImage {
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            mime_type: "image/jpeg".into(),
            width,
            height,
        }
    }
}

/// Um bloco de letras que o app achou e desenhou na imagem como caixa numerada.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkedRegion {
    /// Único dentro do pedido.
    pub id: u32,
    /// Em que imagem do pedido está.
    pub image: usize,
    pub r#box: Box,
    pub letter_height: f32,
    pub glyphs: u32,
}

/// Um pedido ao modelo: uma ou mais faixas seguidas da mesma página, de cima para baixo.
#[derive(Debug, Clone, Default)]
pub struct TranslateRequest {
    pub images: Vec<PageImage>,
    /// Cada caixa marcada recortada e ampliada com o número, mandada depois de `images`.
    pub key: Vec<PageImage>,
    pub regions: Vec<MarkedRegion>,
    pub page_number: u32,
    /// O nome do capítulo, para o conjunto de treino.
    pub chapter: Option<String>,
}
