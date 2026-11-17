//! Baixa as páginas de um capítulo pelo navegador do app. Uso: `fetch <link do capítulo>`.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::args().nth(1).expect("informe o link");
    let started = std::time::Instant::now();
    let chapter = toon_web::download::fetch_chapter(&url, |stage| eprintln!("{stage:?}")).await?;
    let sizes: Vec<usize> = chapter
        .images
        .iter()
        .take(3)
        .map(|i| i.len() / 1000)
        .collect();
    println!(
        "{}: {} páginas em {:?} (primeiras: {sizes:?} KB)",
        chapter.title,
        chapter.images.len(),
        started.elapsed()
    );
    Ok(())
}
