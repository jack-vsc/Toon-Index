//! A que obra (mangá, manhwa, novel) cada capítulo pertence. Cada obra guarda todos os nomes em que já
//! foi vista, então um capítulo chega a ela por qualquer um deles.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::names::{clean_work_name, cut_short, normalize_name, same_name, source_key};

/// Quantas páginas de sites uma obra guarda para procurar capítulos novos.
pub const MAX_SOURCES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shelf {
    Reading,
    Plan,
    Paused,
    Done,
    Dropped,
}

impl Shelf {
    pub const ALL: [Shelf; 5] = [
        Shelf::Reading,
        Shelf::Plan,
        Shelf::Paused,
        Shelf::Done,
        Shelf::Dropped,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Shelf::Reading => "Lendo",
            Shelf::Plan => "Quero ler",
            Shelf::Paused => "Pausado",
            Shelf::Done => "Concluído",
            Shelf::Dropped => "Abandonado",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auto {
    Translate,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Format {
    #[default]
    Comic,
    Novel,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synopsis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCheck {
    pub checked_at: i64,
    #[serde(default)]
    pub sites: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub id: String,
    /// Todos os nomes da obra; o primeiro é o que aparece.
    pub names: Vec<String>,
    /// O nome mostrado foi escolhido no editor: procurar a obra de novo não o troca.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub named_by_hand: bool,
    #[serde(default)]
    pub created_at: i64,
    /// "novel": tem o nome do mangá feito a partir dela, mas é lida à parte.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<CatalogCheck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shelf: Option<Shelf>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<Auto>,
    /// "volume": uma light novel traduzida um volume por vez.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub info: Option<WorkInfo>,
    /// Campos que esta versão não conhece ficam como vieram.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Work {
    pub fn format(&self) -> Format {
        if self.format.as_deref() == Some("novel") {
            Format::Novel
        } else {
            Format::Comic
        }
    }

    pub fn name(&self) -> &str {
        self.names.first().map(String::as_str).unwrap_or("Sem nome")
    }

    pub fn sources(&self) -> &[String] {
        self.sources.as_deref().unwrap_or(&[])
    }

    pub fn is_volumes(&self) -> bool {
        self.unit.as_deref() == Some("volume")
    }

    /// A lista em que a obra está: a escolhida, ou "Lendo" quando algo dela já foi lido.
    pub fn shelf_of(&self, has_reading: bool) -> Option<Shelf> {
        self.shelf.or(has_reading.then_some(Shelf::Reading))
    }

    fn listed(&self) -> bool {
        self.shelf.is_some() || self.favorite
    }
}

/// A obra desse formato com um nome que bate; quando várias batem, ganha o nome mais longo.
pub fn find_work<'a>(works: &'a [Work], name: &str, format: Format) -> Option<&'a Work> {
    let mut best = None;
    let mut best_len = 0;
    for work in works.iter().filter(|w| w.format() == format) {
        for known in &work.names {
            if !same_name(known, name) {
                continue;
            }
            let len = normalize_name(known).len().min(normalize_name(name).len());
            if len > best_len {
                best = Some(work);
                best_len = len;
            }
        }
    }
    best
}

/// Junta um nome que a obra ainda não tinha. Se é uma forma mais completa do nome mostrado, ou o
/// mostrado foi cortado no meio de uma palavra, passa a ser o mostrado.
pub fn with_name(mut work: Work, name: &str) -> Work {
    let clean = clean_work_name(name);
    if clean.is_empty() {
        return work;
    }
    let key = normalize_name(&clean);
    if work.names.iter().any(|n| normalize_name(n) == key) {
        return work;
    }
    let shown = work
        .names
        .first()
        .map(|n| normalize_name(n))
        .unwrap_or_default();
    let related = key.starts_with(&shown) || shown.starts_with(&key);
    let first = work.names.first().cloned().unwrap_or_default();
    // Um nome minúsculo tirado de link não substitui um escrito direito.
    let lowercase = |n: &str| n == n.to_lowercase();
    let better = if cut_short(&first) {
        !cut_short(&clean)
    } else {
        !cut_short(&clean) && key.len() > shown.len() && (!lowercase(&clean) || lowercase(&first))
    };
    if related && better {
        work.names.insert(0, clean);
    } else {
        work.names.push(clean);
    }
    work
}

/// Das obras salvas duas vezes (uma página de site em comum), as que ficam escondidas: fica a que está
/// numa lista ou favorita, senão a primeira.
pub fn duplicate_works(works: &[&Work]) -> HashSet<String> {
    let mut ranked: Vec<&&Work> = works.iter().collect();
    ranked.sort_by_key(|w| std::cmp::Reverse(w.listed()));
    let mut seen = HashSet::new();
    let mut hidden = HashSet::new();
    for w in ranked {
        let keys: Vec<String> = w.sources().iter().map(|s| source_key(s)).collect();
        if keys.iter().any(|k| seen.contains(k)) {
            hidden.insert(w.id.clone());
        } else {
            seen.extend(keys);
        }
    }
    hidden
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(names: &[&str]) -> Work {
        Work {
            id: "1".into(),
            names: names.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn fuller_name_is_shown() {
        let w = with_name(
            work(&["The Mythical Weapon Creation o"]),
            "The Mythical Weapon Creation of the Regressed",
        );
        assert_eq!(w.names[0], "The Mythical Weapon Creation of the Regressed");
        let w = with_name(work(&["Solo Leveling"]), "solo leveling");
        assert_eq!(w.names.len(), 1);
    }

    #[test]
    fn unknown_fields_survive() {
        let json = r#"{"id":"a","names":["X"],"createdAt":1,"novoCampo":{"a":1}}"#;
        let w: Work = serde_json::from_str(json).unwrap();
        let back = serde_json::to_value(&w).unwrap();
        assert_eq!(back["novoCampo"]["a"], 1);
    }
}
