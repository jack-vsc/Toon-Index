//! Lê o texto de uma novel em PDF e mostra um trecho, sem traduzir.
fn main() {
    let path = std::env::args().nth(1).expect("informe o PDF");
    let bytes = std::fs::read(path).unwrap();
    let texts = toon_page::novel::page_texts(&bytes);
    let sizes: Vec<usize> = texts.iter().take(12).map(|t| t.chars().count()).collect();
    println!("{} páginas, novel = {}, letras por página: {sizes:?}", texts.len(), toon_page::novel::looks_like_novel(&texts));
    println!("{}", texts.get(30).map(|t| t.chars().take(600).collect::<String>()).unwrap_or_default());
}
