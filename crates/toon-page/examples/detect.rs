//! Mostra os blocos de texto que o detector acha numa imagem. Uso: `detect <imagem>`.
fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("informe a imagem");
    let image = image::open(&path)?.to_rgba8();
    let started = std::time::Instant::now();
    let regions = toon_page::detect::detect_text(&toon_page::glyphs::Gray::from_rgba(&image));
    println!(
        "{}x{}: {} blocos em {:?}",
        image.width(),
        image.height(),
        regions.len(),
        started.elapsed()
    );
    for r in regions {
        println!(
            "  {:?} letra {:.0} px, {} peças",
            r.r#box, r.letter_height, r.glyphs
        );
    }
    Ok(())
}
