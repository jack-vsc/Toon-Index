//! Avisos de capítulo novo: no Windows, no celular (push pelo Firebase) e, sem Firebase, pelo ntfy.sh.
//! As obras marcadas para traduzir ou baixar sozinhas também entram na fila aqui.

use toon_core::jobs::{self, BatchChapter};
use toon_core::library::{list_library, list_works};
use toon_core::names::display_name;
use toon_core::reading::{self, Status};
use toon_core::updates::{self, WorkUpdate};
use toon_core::works::{Auto, Work};

use crate::cloud;

/// Os links dos capítulos depois de `from` até o mais novo, a partir do link dele quando o número
/// aparece sozinho ("/nome/chapter-100/" dá "/nome/chapter-99/"); senão só o mais novo.
fn chapters_up_to(latest_url: &str, latest: f64, from: f64) -> Vec<BatchChapter> {
    let only = vec![BatchChapter {
        chapter: latest,
        url: latest_url.to_string(),
    }];
    if latest.fract() != 0.0 {
        return only;
    }
    let n = format!("{}", latest as i64);
    let bytes = latest_url.as_bytes();
    let mut at = None;
    let mut i = 0;
    while let Some(pos) = latest_url[i..].find(&n) {
        let start = i + pos;
        let end = start + n.len();
        if (start == 0 || !bytes[start - 1].is_ascii_digit())
            && (end >= bytes.len() || !bytes[end].is_ascii_digit())
        {
            at = Some(start);
        }
        i = start + 1;
    }
    let Some(at) = at else { return only };
    let first = ((from.floor() as i64) + 1).max(latest as i64 - 20);
    (first..=latest as i64)
        .map(|k| BatchChapter {
            chapter: k as f64,
            url: format!("{}{k}{}", &latest_url[..at], &latest_url[at + n.len()..]),
        })
        .collect()
}

/// Os capítulos novos de uma obra que traduz (ou baixa) sozinha entram na fila: os que não estão na
/// biblioteca nem já foram pedidos.
fn queue_new(work: &Work, update: &WorkUpdate, from: f64) -> usize {
    let have: Vec<f64> = list_library()
        .into_iter()
        .filter(|e| e.work_id == work.id)
        .filter_map(|e| e.chapter)
        .collect();
    let asked: Vec<String> = jobs::queue()
        .jobs
        .into_iter()
        .filter_map(|j| j.url)
        .collect();
    let chapters: Vec<BatchChapter> = chapters_up_to(&update.url, update.latest, from)
        .into_iter()
        .filter(|c| !have.contains(&c.chapter) && !asked.contains(&c.url))
        .collect();
    if chapters.is_empty() {
        return 0;
    }
    let download = work.auto == Some(Auto::Download);
    let _ = jobs::add_batch(
        &display_name(work.name()),
        &update.site,
        &chapters,
        download,
        "PC",
        None,
    );
    chapters.len()
}

/// Capítulos mais novos que o último lido e que o último avisado, uma vez cada.
pub async fn announce() {
    let stored = updates::load();
    let works = list_works();
    let records = reading::list();
    let mut announced = stored.announced.clone();
    let mut news = Vec::new();
    for update in updates::work_updates(&works, &stored.checks).into_values() {
        let before = announced.get(&update.work_id).copied();
        announced.insert(
            update.work_id.clone(),
            before.unwrap_or(0.0).max(update.latest),
        );
        // A primeira verificação de uma obra só anota onde ela está.
        let Some(before) = before.filter(|b| update.latest > *b) else {
            continue;
        };
        let read = records
            .iter()
            .filter(|r| r.work_id == update.work_id && r.status == Status::Read)
            .map(|r| r.chapter)
            .fold(f64::MIN, f64::max);
        if read != f64::MIN && update.latest <= read {
            continue;
        }
        let Some(work) = works.iter().find(|w| w.id == update.work_id) else {
            continue;
        };
        let queued = if work.auto.is_some() {
            queue_new(work, &update, before.max(read))
        } else {
            0
        };
        if update.date.is_some() && !update.is_recent() {
            continue;
        }
        let action = match (queued, work.auto) {
            (0, _) => "",
            (_, Some(Auto::Translate)) => " · traduzindo no PC",
            _ => " · baixando no PC",
        };
        news.push((
            display_name(work.name()),
            format!(
                "Capítulo {} em {}{action}",
                jobs::number_text(update.latest),
                update.site
            ),
            update,
        ));
    }
    let _ = updates::change(|s| s.announced = announced);
    for (name, body, update) in news {
        let title = format!("Capítulo novo: {name}");
        windows_toast(&title, &body);
        let pushed = cloud::send_push(&title, &body, &update.work_id, &update.url).await;
        if !pushed {
            if let Some(topic) = stored.ntfy_topic.as_deref() {
                send_ntfy(topic, &title, &body, &update.url).await;
            }
        }
    }
}

/// Um site pede que a pessoa confirme que não é um robô: aviso no Windows e no celular.
pub fn challenge(info: &toon_web::challenge::Info, runtime: &tokio::runtime::Handle) {
    let title = "Verificação pendente";
    let body = format!(
        "{} pede que você confirme que não é um robô. Resolva no celular ou na janela do Toon Index.",
        if info.site.is_empty() {
            "Um site"
        } else {
            &info.site
        }
    );
    toast(title, &body);
    let id = info.id.clone();
    runtime.spawn(async move {
        let pushed = cloud::send_push(title, &body, &format!("challenge:{id}"), "").await;
        if !pushed {
            tracing::info!("verificação pendente sem push (celular sem Firebase)");
        }
    });
}

/// Um aviso do Windows.
pub fn toast(title: &str, body: &str) {
    windows_toast(title, body);
}

fn windows_toast(title: &str, body: &str) {
    if let Err(e) = notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .appname("Toon Index")
        .show()
    {
        tracing::warn!("aviso do Windows falhou: {e}");
    }
}

/// Um push para o celular pelo ntfy.sh; tocar abre o capítulo.
async fn send_ntfy(topic: &str, title: &str, message: &str, click: &str) {
    let body =
        serde_json::json!({ "topic": topic, "title": title, "message": message, "click": click });
    if let Err(e) = reqwest::Client::new()
        .post("https://ntfy.sh/")
        .json(&body)
        .send()
        .await
    {
        tracing::warn!("ntfy falhou: {e}");
    }
}

/// Liga (com um tópico novo, difícil de adivinhar) ou desliga os avisos pelo ntfy.
pub fn set_ntfy(enabled: bool) -> anyhow::Result<Option<String>> {
    let topic = enabled.then(|| format!("toon-index-{}", uuid::Uuid::new_v4().simple()));
    updates::change(|s| s.ntfy_topic = topic.clone())?;
    Ok(topic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_of_the_chapters_in_between() {
        let list = chapters_up_to("https://site.com/obra/chapter-100/", 100.0, 97.0);
        assert_eq!(
            list.iter().map(|c| c.chapter).collect::<Vec<_>>(),
            [98.0, 99.0, 100.0]
        );
        assert_eq!(list[0].url, "https://site.com/obra/chapter-98/");
        assert_eq!(
            chapters_up_to("https://site.com/capitulo/591546", 79.0, 78.0).len(),
            1
        );
    }
}
