//! Testa um perfil salvo com o pedido mínimo (imagem branca de 32 px). Uso: `ping <nome do perfil>`.
#[tokio::main]
async fn main() {
    let name = std::env::args().nth(1).unwrap_or_default();
    let settings = toon_core::settings::load();
    let Some(profile) = settings.profiles.iter().find(|p| p.name == name) else {
        eprintln!("perfil não encontrado");
        std::process::exit(1);
    };
    match toon_ai::test_api(profile, None).await {
        Ok(ms) => println!("{}: respondeu em {ms} ms", profile.name),
        Err(err) => println!("{}: {err}", profile.name),
    }
}
