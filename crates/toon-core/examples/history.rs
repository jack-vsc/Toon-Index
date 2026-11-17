//! Mostra o que o histórico dos navegadores tem de capítulos, sem importar nada.
fn main() {
    let (works, problems) = toon_core::history::scan();
    println!("{} obras no histórico", works.len());
    for w in works.iter().take(8) {
        let last = w.chapters.last().map(|c| c.chapter).unwrap_or_default();
        println!(
            "  {} ({} capítulos, último {last}, {:?})",
            w.name,
            w.chapters.len(),
            w.browsers
        );
    }
    for p in problems {
        println!("  problema: {p}");
    }
}
