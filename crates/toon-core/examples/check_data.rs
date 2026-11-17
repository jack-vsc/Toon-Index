//! Lê os dados reais sem mudar nada e diz o que achou (sem mostrar chave nenhuma).
fn main() {
    let works = toon_core::library::list_works();
    println!("obras: {}", works.len());
    let settings = toon_core::settings::load();
    println!("perfis: {}", settings.profiles.len());
    for p in &settings.profiles {
        let opened = toon_core::settings::api_key(&p.id).is_some();
        println!("  perfil {:?}: chave aberta = {opened}", p.name);
    }
    println!("leituras: {}", toon_core::reading::list().len());
}
