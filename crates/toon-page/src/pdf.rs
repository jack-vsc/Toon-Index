//! PDFs de capítulo. Os do app são uma imagem por página (JPEG ou PNG); é isso que se lê e se grava.
//! PDF com texto ou desenho vetorial precisaria de um renderizador e fica de fora por enquanto.

use anyhow::{Context, bail};
use image::{DynamicImage, ImageBuffer, Luma, Rgb};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, Stream, dictionary};

/// Uma página: a imagem como estava no arquivo e o tamanho físico da página em pontos.
pub struct PdfPage {
    pub image: DynamicImage,
    /// Os bytes originais, quando a página já era um JPEG (dá para gravar de volta sem recomprimir).
    pub jpeg: Option<Vec<u8>>,
    pub width_pt: f32,
    pub height_pt: f32,
}

/// Faixas de webtoon são bem mais altas que largas e se tratam pela largura, não pelo lado maior.
pub fn is_tall(width_pt: f32, height_pt: f32) -> bool {
    height_pt / width_pt > 2.2
}

pub fn page_count(bytes: &[u8]) -> anyhow::Result<usize> {
    Ok(Document::load_mem(bytes).context("PDF ilegível")?.get_pages().len())
}

/// As páginas do PDF na ordem, cada uma com a maior imagem que ela desenha.
pub fn read_pages(bytes: &[u8]) -> anyhow::Result<Vec<PdfPage>> {
    let doc = Document::load_mem(bytes).context("PDF ilegível")?;
    let mut pages = Vec::new();
    for (number, id) in doc.get_pages() {
        let (width_pt, height_pt) = page_size(&doc, id).unwrap_or((595.0, 842.0));
        let images = doc.get_page_images(id).unwrap_or_default();
        let Some(best) = images.iter().max_by_key(|i| i.width * i.height) else {
            bail!("A página {number} não tem imagem: PDFs de texto ainda não são lidos por esta versão.");
        };
        let filters = best.filters.clone().unwrap_or_default();
        let (image, jpeg) = if filters.iter().any(|f| f == "DCTDecode") {
            let data = best.content.to_vec();
            (image::load_from_memory_with_format(&data, image::ImageFormat::Jpeg)?, Some(data))
        } else {
            let stream = doc.get_object(best.id)?.as_stream()?;
            let raw = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
            (raw_image(&raw, best.width as u32, best.height as u32, best.color_space.as_deref())?, None)
        };
        pages.push(PdfPage { image, jpeg, width_pt, height_pt });
    }
    Ok(pages)
}

fn page_size(doc: &Document, id: lopdf::ObjectId) -> Option<(f32, f32)> {
    let mut dict = doc.get_dictionary(id).ok()?;
    // A MediaBox pode estar no nó pai.
    loop {
        if let Ok(b) = dict.get(b"MediaBox").and_then(Object::as_array) {
            let n: Vec<f32> = b.iter().filter_map(|o| o.as_float().ok().or_else(|| o.as_i64().ok().map(|v| v as f32))).collect();
            if n.len() == 4 {
                return Some(((n[2] - n[0]).abs(), (n[3] - n[1]).abs()));
            }
        }
        let parent = dict.get(b"Parent").and_then(Object::as_reference).ok()?;
        dict = doc.get_dictionary(parent).ok()?;
    }
}

fn raw_image(raw: &[u8], w: u32, h: u32, color_space: Option<&str>) -> anyhow::Result<DynamicImage> {
    let pixels = (w * h) as usize;
    match color_space {
        Some("DeviceGray") if raw.len() >= pixels => {
            Ok(DynamicImage::ImageLuma8(ImageBuffer::<Luma<u8>, _>::from_raw(w, h, raw[..pixels].to_vec()).context("imagem cinza")?))
        }
        _ if raw.len() >= pixels * 3 => {
            Ok(DynamicImage::ImageRgb8(ImageBuffer::<Rgb<u8>, _>::from_raw(w, h, raw[..pixels * 3].to_vec()).context("imagem RGB")?))
        }
        _ => bail!("Formato de imagem do PDF não suportado."),
    }
}

/// Uma página do PDF de saída: o JPEG e o tamanho físico da página de onde veio.
pub struct OutputPage {
    pub jpeg: Vec<u8>,
    pub width_px: u32,
    pub height_px: u32,
    pub width_pt: f32,
    pub height_pt: f32,
}

/// Um PDF com uma imagem por página, no tamanho físico das páginas originais.
pub fn build_pdf(pages: &[OutputPage], title: &str) -> anyhow::Result<Vec<u8>> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for page in pages {
        let image = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => page.width_px as i64,
                "Height" => page.height_px as i64,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            page.jpeg.clone(),
        );
        let image_id = doc.add_object(image);
        let content = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new("cm", vec![page.width_pt.into(), 0.into(), 0.into(), page.height_pt.into(), 0.into(), 0.into()]),
                Operation::new("Do", vec!["Im0".into()]),
                Operation::new("Q", vec![]),
            ],
        };
        let content_id = doc.add_object(Stream::new(Dictionary::new(), content.encode()?));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), page.width_pt.into(), page.height_pt.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
            "Contents" => content_id,
        });
        kids.push(Object::Reference(page_id));
    }
    let count = kids.len() as i64;
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    let info = doc.add_object(dictionary! {
        "Title" => Object::string_literal(title),
        "Creator" => Object::string_literal("Toon Index"),
    });
    doc.trailer.set("Root", catalog);
    doc.trailer.set("Info", info);
    let mut out = Vec::new();
    doc.save_to(&mut out)?;
    Ok(out)
}

pub fn encode_jpeg(image: &image::RgbImage, quality: u8) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode_image(image)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_back() {
        let img = image::RgbImage::from_pixel(40, 80, Rgb([200, 10, 10]));
        let jpeg = encode_jpeg(&img, 90).unwrap();
        let pdf = build_pdf(
            &[OutputPage { jpeg: jpeg.clone(), width_px: 40, height_px: 80, width_pt: 30.0, height_pt: 60.0 }],
            "Teste",
        )
        .unwrap();
        let pages = read_pages(&pdf).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!((pages[0].width_pt, pages[0].height_pt), (30.0, 60.0));
        assert_eq!(pages[0].image.width(), 40);
        assert_eq!(pages[0].jpeg.as_deref(), Some(jpeg.as_slice()));
    }
}
