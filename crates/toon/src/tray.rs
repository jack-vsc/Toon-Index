//! A bandeja do Windows, como na versão em Electron: fechar a janela só a esconde, e o app continua
//! atendendo o celular e a extensão, andando com a fila e verificando os capítulos novos. O ícone
//! perto do relógio abre a janela de novo (clique) ou fecha o app de vez ("Sair").
//!
//! Só uma cópia roda por vez: abrir o atalho com o app escondido traz a janela de volta, em vez de
//! abrir outro app disputando a mesma porta.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use eframe::egui;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HWND};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, IsIconic, SW_HIDE, SW_RESTORE, SW_SHOW, SetForegroundWindow, ShowWindow,
};
use windows::core::{PCWSTR, w};

/// O título da janela, pelo qual uma segunda cópia acha a primeira.
pub const TITLE: &str = "Toon Index";
const ICON: &[u8] = include_bytes!("../../../assets/icon/icon.png");

static WINDOW: AtomicIsize = AtomicIsize::new(0);
/// "Sair" foi escolhido: o próximo pedido de fechar fecha mesmo.
pub static QUITTING: AtomicBool = AtomicBool::new(false);
static TOLD: AtomicBool = AtomicBool::new(false);

fn icon_rgba() -> Option<(Vec<u8>, u32, u32)> {
    let image = image::load_from_memory(ICON).ok()?.to_rgba8();
    let (w, h) = image.dimensions();
    Some((image.into_raw(), w, h))
}

/// O ícone da janela e da barra de tarefas.
pub fn window_icon() -> Option<egui::IconData> {
    let (rgba, width, height) = icon_rgba()?;
    Some(egui::IconData {
        rgba,
        width,
        height,
    })
}

/// Aberto com o Windows (`--minimized`): começa escondido na bandeja.
pub fn starts_hidden() -> bool {
    std::env::args().any(|a| a == "--minimized" || a == "--hidden")
}

/// Se outra cópia já está rodando, traz a janela dela para a frente e devolve `true`.
pub fn focus_running_copy() -> bool {
    // O mutex fica aberto até o processo terminar.
    let created = unsafe { CreateMutexW(None, true, w!("Local\\ToonIndex.SingleInstance")) };
    let exists = created.is_ok() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if !exists {
        return false;
    }
    let title: Vec<u16> = TITLE.encode_utf16().chain(Some(0)).collect();
    // A classe das janelas do winit, junto do título: uma pasta "Toon Index" aberta no Explorer
    // tem o mesmo título.
    if let Ok(hwnd) = unsafe { FindWindowW(w!("Window Class"), PCWSTR(title.as_ptr())) } {
        bring_up(hwnd);
    }
    true
}

fn bring_up(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
    }
}

fn window() -> Option<HWND> {
    match WINDOW.load(Ordering::Relaxed) {
        0 => None,
        h => Some(HWND(h as *mut _)),
    }
}

/// Põe o ícone na bandeja. Fica no ar enquanto o valor devolvido existir.
pub fn create(cc: &eframe::CreationContext) -> Option<TrayIcon> {
    if let Ok(handle) = cc.window_handle() {
        if let RawWindowHandle::Win32(h) = handle.as_raw() {
            WINDOW.store(h.hwnd.get(), Ordering::Relaxed);
        }
    }
    let menu = Menu::new();
    let open = MenuItem::new("Abrir o Toon Index", true, None);
    let quit = MenuItem::new("Sair", true, None);
    menu.append_items(&[&open, &quit]).ok()?;
    let (rgba, w, h) = icon_rgba()?;
    let tray = TrayIconBuilder::new()
        .with_tooltip(TITLE)
        .with_icon(Icon::from_rgba(rgba, w, h).ok()?)
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .build()
        .map_err(|e| tracing::warn!("ícone da bandeja: {e}"))
        .ok()?;
    let (open_id, quit_id) = (open.id().clone(), quit.id().clone());
    let ctx = cc.egui_ctx.clone();
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        if e.id == open_id {
            show(&ctx);
        } else if e.id == quit_id {
            QUITTING.store(true, Ordering::Relaxed);
            show(&ctx);
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            ctx.request_repaint();
        }
    }));
    let ctx = cc.egui_ctx.clone();
    TrayIconEvent::set_event_handler(Some(move |e: TrayIconEvent| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = e
        {
            show(&ctx);
        }
    }));
    Some(tray)
}

/// Traz a janela escondida de volta.
pub fn show(ctx: &egui::Context) {
    if let Some(hwnd) = window() {
        bring_up(hwnd);
    }
    ctx.request_repaint();
}

/// Esconde a janela sem avisar (aberto com o Windows).
pub fn hide_quietly() {
    if let Some(hwnd) = window() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

/// Esconde a janela; na primeira vez, um aviso diz onde o app ficou.
pub fn hide() {
    hide_quietly();
    if !TOLD.swap(true, Ordering::Relaxed) {
        crate::notify::toast(
            TITLE,
            "Continua rodando perto do relógio. Clique no ícone para abrir, ou em Sair para fechar.",
        );
    }
}
