//! Passa uma imagem pelo servidor de visão: blocos e balões achados, e a página com as letras apagadas
//! pelo LaMa ao lado dela. Uso: `TOON_VISION_DIR=<pasta> vision <imagem>`.
fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("informe a imagem");
    let mut image = image::open(&path)?.to_rgb8();
    let started = std::time::Instant::now();
    let Some(scene) = toon_page::vision::detect(&image) else {
        anyhow::bail!(
            "o servidor de visão não respondeu: {:?}",
            toon_page::vision::status()
        );
    };
    println!(
        "{}x{}: {} blocos, {} balões em {:?}",
        scene.width,
        scene.height,
        scene.blocks.len(),
        scene.bubbles.len(),
        started.elapsed()
    );
    for b in &scene.blocks {
        println!(
            "  {:?} letra {:.0} px, balão {}",
            b.bbox, b.letter_height, b.bubble
        );
    }
    let mut mask = vec![0u8; scene.width * scene.height];
    for b in &scene.blocks {
        toon_page::vision::add_erase_area(&mut mask, &scene, b.bbox, b.letter_height, None);
    }
    let started = std::time::Instant::now();
    anyhow::ensure!(
        toon_page::vision::inpaint(&mut image, &mask),
        "o LaMa falhou"
    );
    let out = std::path::Path::new(&path).with_extension("clean.png");
    image.save(&out)?;
    println!("apagada em {:?}: {}", started.elapsed(), out.display());
    // O overlay inteiro com os modelos: cada bloco vira uma fala de teste escrita no lugar.
    let mut page = image::open(&path)?.to_rgb8();
    let blocks: Vec<toon_ai::TextBlock> = scene
        .blocks
        .iter()
        .map(|b| toon_ai::TextBlock {
            text_box: b.bbox,
            area_box: b.bbox,
            ink_boxes: Some(vec![b.bbox]),
            letter_height: Some(b.letter_height),
            original: "ORIGINAL TEXT HERE".into(),
            translation: "Texto de teste".into(),
            ..Default::default()
        })
        .collect();
    let drawn = toon_page::overlay::draw_overlay(&mut page, &blocks, Some(&scene));
    let out = std::path::Path::new(&path).with_extension("overlay.png");
    page.save(&out)?;
    println!(
        "overlay: {} de {} blocos escritos: {}",
        drawn.iter().filter(|d| d.drawn).count(),
        blocks.len(),
        out.display()
    );
    toon_page::vision::stop();
    Ok(())
}
