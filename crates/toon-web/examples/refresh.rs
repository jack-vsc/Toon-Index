//! "Atualizar dados" de uma obra. Uso: `refresh <id da obra>` (use TOON_DATA_DIR para uma cópia).
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let id = std::env::args().nth(1).expect("informe o id da obra");
    let works = toon_web::details::refresh_work(&id).await?;
    let w = works.iter().find(|w| w.id == id).unwrap();
    let info = w.info.clone().unwrap_or_default();
    println!(
        "{} | {:?} | {:?} | ano {:?} | capa {}",
        w.names[0],
        info.status,
        info.tags,
        info.year,
        toon_core::library::work_cover(&id).is_some()
    );
    println!(
        "sinopse: {}",
        info.synopsis
            .unwrap_or_default()
            .chars()
            .take(160)
            .collect::<String>()
    );
    Ok(())
}
