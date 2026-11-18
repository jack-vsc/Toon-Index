//! O visual da versão em Electron: o tema escuro do MangaDex com o laranja dele, a Segoe UI do
//! Windows no texto e rótulos pequenos em fonte mono (Cascadia Mono).

use std::sync::Arc;

use eframe::egui::{
    self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, RichText, Stroke,
    TextStyle, Vec2,
};

pub const BG: Color32 = Color32::from_rgb(0x13, 0x13, 0x15);
pub const SIDEBAR: Color32 = Color32::from_rgb(0x19, 0x19, 0x1c);
pub const PANEL: Color32 = Color32::from_rgb(0x1e, 0x1e, 0x22);
pub const PANEL_2: Color32 = Color32::from_rgb(0x29, 0x29, 0x2e);
pub const BORDER: Color32 = Color32::from_rgb(0x33, 0x33, 0x3a);
pub const TEXT: Color32 = Color32::from_rgb(0xed, 0xed, 0xf0);
pub const MUTED: Color32 = Color32::from_rgb(0x9e, 0x9e, 0xa8);
pub const ACCENT: Color32 = Color32::from_rgb(0xff, 0x67, 0x40);
pub const ACCENT_2: Color32 = Color32::from_rgb(0xff, 0x8a, 0x5c);
pub const OK: Color32 = Color32::from_rgb(0x4c, 0xcf, 0x8a);
pub const ERR: Color32 = Color32::from_rgb(0xff, 0x6b, 0x6b);

/// Títulos e itens ativos: a Segoe UI semibold.
pub fn bold() -> FontFamily {
    FontFamily::Name("bold".into())
}

/// Um rótulo pequeno em maiúsculas mono, como os grupos da barra lateral.
pub fn mono_label(text: &str) -> RichText {
    RichText::new(text.to_uppercase())
        .family(FontFamily::Monospace)
        .size(11.0)
        .color(MUTED)
}

pub fn heading(text: impl Into<String>, size: f32) -> RichText {
    RichText::new(text).family(bold()).size(size).color(TEXT)
}

/// As fontes do Windows; sem elas, ficam as do egui.
fn fonts() -> FontDefinitions {
    let mut fonts = FontDefinitions::default();
    let dir =
        std::path::PathBuf::from(std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into()))
            .join("Fonts");
    let mut load = |name: &str, files: &[&str]| -> bool {
        for f in files {
            if let Ok(bytes) = std::fs::read(dir.join(f)) {
                fonts
                    .font_data
                    .insert(name.into(), Arc::new(FontData::from_owned(bytes)));
                return true;
            }
        }
        false
    };
    let text = load("segoe", &["segoeui.ttf"]);
    let semibold = load("segoe-semibold", &["seguisb.ttf", "segoeuib.ttf"]);
    let mono = load("mono", &["CascadiaMono.ttf", "consola.ttf"]);
    let symbols = load("symbols", &["seguisym.ttf"]);
    // As fontes do egui continuam atrás, para os ícones e emojis.
    let fallback = fonts.families[&FontFamily::Proportional].clone();
    let chain = |first: Option<&str>| {
        let mut list: Vec<String> = first.into_iter().map(String::from).collect();
        if symbols {
            list.push("symbols".into());
        }
        list.extend(fallback.iter().cloned());
        list
    };
    let proportional = chain(text.then_some("segoe"));
    let heavy = chain(if semibold {
        Some("segoe-semibold")
    } else if text {
        Some("segoe")
    } else {
        None
    });
    fonts
        .families
        .insert(FontFamily::Proportional, proportional);
    fonts.families.insert(bold(), heavy);
    if mono {
        fonts
            .families
            .get_mut(&FontFamily::Monospace)
            .unwrap()
            .insert(0, "mono".into());
    }
    fonts
}

pub fn apply(ctx: &egui::Context) {
    ctx.set_fonts(fonts());
    let mut style = (*ctx.style()).clone();
    style.text_styles = [
        (TextStyle::Small, FontId::proportional(12.0)),
        (TextStyle::Body, FontId::proportional(14.0)),
        (TextStyle::Button, FontId::proportional(14.0)),
        (TextStyle::Heading, FontId::new(22.0, bold())),
        (TextStyle::Monospace, FontId::monospace(12.0)),
    ]
    .into();
    style.spacing.item_spacing = Vec2::new(8.0, 6.0);
    style.spacing.button_padding = Vec2::new(12.0, 6.0);
    style.spacing.interact_size.y = 30.0;
    let v = &mut style.visuals;
    *v = egui::Visuals::dark();
    v.override_text_color = None;
    v.panel_fill = BG;
    v.window_fill = PANEL;
    v.window_stroke = Stroke::new(1.0_f32, BORDER);
    v.window_corner_radius = CornerRadius::same(14);
    v.menu_corner_radius = CornerRadius::same(8);
    v.extreme_bg_color = BG;
    v.faint_bg_color = PANEL;
    v.code_bg_color = PANEL_2;
    v.hyperlink_color = ACCENT_2;
    v.warn_fg_color = ACCENT_2;
    v.error_fg_color = ERR;
    v.selection.bg_fill = ACCENT;
    v.selection.stroke = Stroke::new(1.0_f32, Color32::WHITE);
    let radius = CornerRadius::same(8);
    let w = &mut v.widgets;
    w.noninteractive.bg_fill = PANEL;
    w.noninteractive.weak_bg_fill = PANEL;
    w.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER);
    w.noninteractive.fg_stroke = Stroke::new(1.0_f32, TEXT);
    w.noninteractive.corner_radius = radius;
    w.inactive.bg_fill = PANEL_2;
    w.inactive.weak_bg_fill = PANEL_2;
    w.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER);
    w.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT);
    w.inactive.corner_radius = radius;
    w.hovered.bg_fill = Color32::from_rgb(0x34, 0x34, 0x3a);
    w.hovered.weak_bg_fill = Color32::from_rgb(0x34, 0x34, 0x3a);
    w.hovered.bg_stroke = Stroke::new(1.0_f32, Color32::from_rgb(0x48, 0x48, 0x50));
    w.hovered.fg_stroke = Stroke::new(1.5_f32, Color32::WHITE);
    w.hovered.corner_radius = radius;
    w.hovered.expansion = 0.0;
    w.active.bg_fill = ACCENT;
    w.active.weak_bg_fill = ACCENT;
    w.active.bg_stroke = Stroke::new(1.0_f32, ACCENT);
    w.active.fg_stroke = Stroke::new(1.5_f32, Color32::WHITE);
    w.active.corner_radius = radius;
    w.active.expansion = 0.0;
    w.open = w.hovered;
    // Sempre o tema escuro, qualquer que seja o tema do Windows.
    ctx.set_theme(egui::ThemePreference::Dark);
    ctx.set_style_of(egui::Theme::Dark, style);
}

/// Um painel arredondado da largura da tela, como os quadros da versão em Electron.
pub fn card<R>(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::new()
        .fill(PANEL)
        .stroke(Stroke::new(1.0_f32, BORDER))
        .corner_radius(CornerRadius::same(14))
        .inner_margin(egui::Margin::same(18))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui)
        })
        .inner
}

/// Um botão laranja, o principal da tela.
pub fn primary(text: &str) -> egui::Button<'static> {
    egui::Button::new(
        RichText::new(text.to_string())
            .family(bold())
            .color(Color32::WHITE),
    )
    .fill(ACCENT)
    .stroke(Stroke::NONE)
}

/// Um item da barra lateral: ícone, nome e, opcional, um número à direita.
pub fn nav_item(ui: &mut egui::Ui, icon: &str, label: &str, active: bool, badge: usize) -> bool {
    let width = ui.available_width();
    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, 36.0), egui::Sense::click());
    let painter = ui.painter_at(rect);
    let fill = if active {
        ACCENT
    } else if response.hovered() {
        PANEL_2
    } else {
        Color32::TRANSPARENT
    };
    painter.rect_filled(rect, CornerRadius::same(8), fill);
    let color = if active { Color32::WHITE } else { TEXT };
    painter.text(
        rect.left_center() + Vec2::new(14.0, 0.0),
        egui::Align2::LEFT_CENTER,
        icon,
        FontId::proportional(15.0),
        if active { Color32::WHITE } else { MUTED },
    );
    painter.text(
        rect.left_center() + Vec2::new(42.0, 0.0),
        egui::Align2::LEFT_CENTER,
        label,
        FontId::new(
            14.0,
            if active {
                bold()
            } else {
                FontFamily::Proportional
            },
        ),
        color,
    );
    if badge > 0 {
        let text = badge.to_string();
        let galley = painter.layout_no_wrap(text, FontId::new(11.0, bold()), Color32::WHITE);
        let size = Vec2::new(galley.size().x + 16.0, 18.0);
        let pill = egui::Rect::from_center_size(
            rect.right_center() - Vec2::new(size.x / 2.0 + 10.0, 0.0),
            size,
        );
        let (bg, fg) = if active {
            (Color32::WHITE, ACCENT)
        } else {
            (ACCENT, Color32::WHITE)
        };
        painter.rect_filled(pill, CornerRadius::same(9), bg);
        painter.galley_with_override_text_color(pill.center() - galley.size() / 2.0, galley, fg);
    }
    response
        .on_hover_cursor(egui::CursorIcon::PointingHand)
        .clicked()
}

/// Um filtro em pílula ("Todas", "Lendo"…).
pub fn chip(ui: &mut egui::Ui, text: &str, active: bool) -> bool {
    let button = egui::Button::new(
        RichText::new(text)
            .family(bold())
            .size(13.0)
            .color(if active { Color32::WHITE } else { MUTED }),
    )
    .fill(if active { ACCENT } else { PANEL_2 })
    .stroke(Stroke::new(1.0_f32, if active { ACCENT } else { BORDER }))
    .corner_radius(CornerRadius::same(255));
    ui.add(button).clicked()
}
