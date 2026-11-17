//! Testa um perfil salvo com o pedido mínimo (imagem branca de 32 px). Uso: `ping <nome do perfil>`.
#[tokio::main]
async fn main() {
    let name = std::env::args().nth(1).unwrap_or_default();
    let mut settings = toon_core::settings::load();
    // "local:<modelo>" testa o modelo próprio do app, como o perfil "Neste PC".
    if let Some(model) = name.strip_prefix("local:") {
        settings.profiles.push(toon_core::settings::ApiProfile {
            id: toon_core::settings::LOCAL_AI_PROFILE_ID.into(),
            name: name.clone(),
            base_url: toon_core::settings::LOCAL_AI_BASE_URL.into(),
            model: model.into(),
            ..Default::default()
        });
    }
    let Some(profile) = settings.profiles.iter().find(|p| p.name == name) else {
        eprintln!("perfil não encontrado");
        std::process::exit(1);
    };
    match toon_ai::test_api(profile, None).await {
        Ok(ms) => println!("{}: respondeu em {ms} ms", profile.name),
        Err(err) => println!("{}: {err}", profile.name),
    }
}
