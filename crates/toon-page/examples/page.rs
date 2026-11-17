//! Traduz uma página de um PDF da biblioteca com o perfil ativo e grava o resultado em JPEG.
//! Uso: `page <arquivo.pdf> <número da página> <saída.jpg>`.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let pages = toon_page::pdf::read_pages(&std::fs::read(&args[1])?)?;
    let number: usize = args[2].parse()?;
    let ready = toon_ai::ready(toon_core::settings::load())?;
    let started = std::time::Instant::now();
    let done = toon_page::page::translate_page(&ready, &pages[number - 1], number as u32, Some("teste".into()), &toon_ai::Cancel::default()).await?;
    for b in &done.blocks {
        println!("{:?} {:?} -> {:?}", b.kind, b.original, b.translation);
    }
    done.image.save(&args[3])?;
    println!("{} blocos em {:?}", done.blocks.len(), started.elapsed());
    Ok(())
}
