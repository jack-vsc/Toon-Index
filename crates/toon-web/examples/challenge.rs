//! Uma verificação de mentira ("Just a moment…" com um botão que a libera) passada como o celular
//! passaria: a imagem da página e um toque no botão. Uso: `TOON_DATA_DIR=<cópia> challenge`.
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let page = "data:text/html,<title>Just a moment...</title><body style='margin:0'>\
        <button style='position:absolute;left:40%25;top:40%25;width:20%25;height:20%25' \
        onclick=\"document.title='Liberado';document.body.innerHTML='ok'\">Sou humano</button></body>";
    let mut tab = toon_web::browser::Tab::new().await?;
    tab.open(page).await?;
    let waiting = tokio::spawn(async move {
        let result = tab
            .pass_challenge(|| println!("aviso: verificação pendente"))
            .await;
        (result, tab)
    });
    // Espera a verificação entrar na lista (6 s).
    let id = loop {
        if let Some(c) = toon_web::challenge::list().into_iter().next() {
            println!("pendente: {} ({})", c.id, c.site);
            break c.id;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    let frame = toon_web::challenge::frame(&id).await?;
    println!("imagem da página: {} bytes", frame.len());
    std::fs::write(std::env::temp_dir().join("toon-challenge.jpg"), &frame)?;
    // O meio da imagem é o botão.
    toon_web::challenge::press(&id, 0.5, 0.5, "tap").await?;
    let (result, _tab) = waiting.await?;
    println!(
        "verificação: {:?}; pendentes agora: {}",
        result.map(|_| "passou"),
        toon_web::challenge::list().len()
    );
    Ok(())
}
