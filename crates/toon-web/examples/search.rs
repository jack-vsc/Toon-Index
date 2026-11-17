//! Procura uma obra nos sites e lista os capítulos do primeiro resultado de cada um.
//! Uso: `search <nome>`.
#[tokio::main]
async fn main() {
    let name = std::env::args().nth(1).expect("informe o nome");
    for result in toon_web::catalog::search(&name).await {
        let first = result.matches.first();
        println!(
            "{}: {} resultados {}",
            result.site.label(),
            result.matches.len(),
            result.error.clone().unwrap_or_default()
        );
        if let Some(m) = first {
            match toon_web::catalog::chapter_list(m.site, &m.url).await {
                Ok(list) => println!(
                    "  {} -> {} capítulos (último {:?})",
                    m.title,
                    list.chapters.len(),
                    list.chapters.last().map(|c| c.chapter)
                ),
                Err(err) => println!("  {} -> erro: {err}", m.title),
            }
        }
    }
}
