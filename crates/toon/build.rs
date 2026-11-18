//! O ícone do Toon Index no executável (atalhos, Explorer, barra de tarefas).
fn main() {
    println!("cargo:rerun-if-changed=../../assets/icon/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../../assets/icon/icon.ico");
        if let Err(e) = res.compile() {
            println!("cargo:warning=ícone do executável: {e}");
        }
    }
}
