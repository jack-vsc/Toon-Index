//! A janela: biblioteca e leitor, busca nos sites, fila, PDFs, celular e configurações.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use eframe::egui::{self, Color32, ColorImage, RichText, TextureHandle, TextureOptions, Vec2};
use toon_core::devices;
use toon_core::jobs::{self, BatchChapter, Queue, Status};
use toon_core::library::{self, Entry};
use toon_core::names::display_name;
use toon_core::reading::{self, Status as ReadStatus};
use toon_core::settings::{self, ApiProfile, LANGUAGES, ProviderKind, Settings, Speed, Thinking};
use toon_core::works::{Shelf, Work};
use toon_web::catalog::{self, ChapterList, Match, SiteResult};

use crate::engine::{self, Engine};
use crate::tasks::Pending;

mod panels;
pub mod theme;

const ACCENT: Color32 = theme::ACCENT;

#[derive(PartialEq, Clone, Copy)]
enum Tab {
    Library,
    Search,
    Queue,
    Pdf,
    Phone,
    Settings,
}

pub struct App {
    engine: Arc<Engine>,
    runtime: tokio::runtime::Runtime,
    tab: Tab,
    // Biblioteca
    works: Vec<Work>,
    entries: Vec<Entry>,
    filter: String,
    shelf: Option<Shelf>,
    selected: Option<String>,
    covers: HashMap<String, Option<TextureHandle>>,
    reader: Option<Reader>,
    selected_entry: Option<String>,
    refreshing: Option<Pending<Result<(), String>>>,
    history: Option<Vec<toon_core::history::HistoryWork>>,
    history_pick: Vec<bool>,
    storage: Option<toon_core::storage::Usage>,
    // Busca
    query: String,
    searching: Option<Pending<Vec<SiteResult>>>,
    results: Vec<SiteResult>,
    picked: Option<Match>,
    listing: Option<Pending<Result<ChapterList, String>>>,
    chapters: Option<ChapterList>,
    from: f64,
    to: f64,
    // Fila
    queue: Queue,
    // Celular
    pairing: Option<(String, TextureHandle)>,
    // Configurações
    settings: Settings,
    keys: BTreeMap<String, String>,
    hints: BTreeMap<String, String>,
    testing: Option<Pending<String>>,
    test_result: String,
    notice: String,
    /// O ícone perto do relógio; sem ele, fechar a janela fecha o app.
    tray: Option<tray_icon::TrayIcon>,
    logo: Option<TextureHandle>,
}

/// O capítulo aberto: as páginas, decodificadas aos poucos.
struct Reader {
    title: String,
    pages: Pending<Result<Vec<image::RgbaImage>, String>>,
    textures: Vec<TextureHandle>,
    error: Option<String>,
}

impl App {
    pub fn new(
        cc: &eframe::CreationContext,
        engine: Arc<Engine>,
        runtime: tokio::runtime::Runtime,
    ) -> Self {
        theme::apply(&cc.egui_ctx);
        let logo = image::load_from_memory(include_bytes!("../../../../assets/icon/icon.png"))
            .ok()
            .map(|i| texture(&cc.egui_ctx, "logo", &i.to_rgba8()));
        let mut app = App {
            engine,
            runtime,
            tab: Tab::Library,
            works: Vec::new(),
            entries: Vec::new(),
            filter: String::new(),
            shelf: None,
            selected: None,
            covers: HashMap::new(),
            reader: None,
            selected_entry: None,
            refreshing: None,
            history: None,
            history_pick: Vec::new(),
            storage: None,
            query: String::new(),
            searching: None,
            results: Vec::new(),
            picked: None,
            listing: None,
            chapters: None,
            from: 0.0,
            to: 0.0,
            queue: Queue::default(),
            pairing: None,
            settings: settings::load(),
            keys: BTreeMap::new(),
            hints: settings::key_hints(),
            testing: None,
            test_result: String::new(),
            notice: String::new(),
            tray: crate::tray::create(cc),
            logo,
        };
        app.reload();
        app
    }

    fn reload(&mut self) {
        self.works = library::list_works();
        self.entries = library::list_library();
        self.queue = jobs::queue();
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Aberto com o Windows: o eframe mostra a janela depois do primeiro quadro, e ela volta para
        // a bandeja.
        if self.tray.is_some() && ctx.cumulative_pass_nr() < 3 && crate::tray::starts_hidden() {
            crate::tray::hide_quietly();
        }
        // Fechar a janela só a esconde: o app segue na bandeja até "Sair".
        if ctx.input(|i| i.viewport().close_requested())
            && self.tray.is_some()
            && !crate::tray::QUITTING.load(std::sync::atomic::Ordering::Relaxed)
        {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            crate::tray::hide();
        }
        self.screenshot(ctx);
        if std::mem::take(&mut *self.engine.dirty.lock()) {
            self.reload();
        }
        // A fila anda sozinha: a janela olha de vez em quando.
        ctx.request_repaint_after(std::time::Duration::from_secs(2));
        if self.queue.jobs.iter().any(|j| j.status == Status::Running) {
            self.queue = jobs::queue();
        }
        self.sidebar(ctx);
        egui::TopBottomPanel::bottom("status")
            .frame(
                egui::Frame::new()
                    .fill(theme::PANEL)
                    .stroke(egui::Stroke::new(1.0_f32, theme::BORDER))
                    .inner_margin(egui::Margin::symmetric(16, 6)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    let status = self.engine.status.lock().clone();
                    ui.label(
                        RichText::new(if self.notice.is_empty() {
                            status
                        } else {
                            self.notice.clone()
                        })
                        .color(theme::MUTED),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if self.engine.is_checking() {
                            ui.spinner();
                        } else if ui.small_button("Procurar capítulos novos").clicked() {
                            let engine = self.engine.clone();
                            self.runtime
                                .spawn(async move { engine::check_now(&engine).await });
                        }
                    });
                });
            });
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(theme::BG)
                    .inner_margin(egui::Margin::symmetric(32, 24)),
            )
            .show(ctx, |ui| match self.tab {
                Tab::Library => self.library(ui, ctx),
                Tab::Search => self.search(ui, ctx),
                Tab::Queue => self.queue_tab(ui),
                Tab::Pdf => self.pdf_tab(ui),
                Tab::Phone => self.phone(ui, ctx),
                Tab::Settings => self.settings_tab(ui, ctx),
            });
    }
}

impl App {
    /// `--screenshot <arquivo.png> [aba]`: grava a janela depois de alguns segundos e fecha (testes).
    fn screenshot(&mut self, ctx: &egui::Context) {
        let args: Vec<String> = std::env::args().collect();
        let Some(at) = args.iter().position(|a| a == "--screenshot") else {
            return;
        };
        let Some(file) = args.get(at + 1) else { return };
        if let Some(tab) = args.get(at + 2) {
            self.tab = match tab.as_str() {
                "busca" => Tab::Search,
                "fila" => Tab::Queue,
                "pdf" => Tab::Pdf,
                "celular" => Tab::Phone,
                "config" => Tab::Settings,
                _ => Tab::Library,
            };
            if tab == "obra" && self.selected.is_none() {
                self.selected = self.works.first().map(|w| w.id.clone());
            }
        }
        let shot = ctx.input(|i| {
            i.raw.events.iter().find_map(|e| {
                if let egui::Event::Screenshot { image, .. } = e {
                    Some(image.clone())
                } else {
                    None
                }
            })
        });
        if let Some(image) = shot {
            let [w, h] = image.size;
            let rgba: Vec<u8> = image.pixels.iter().flat_map(|c| c.to_array()).collect();
            if let Some(img) = image::RgbaImage::from_raw(w as u32, h as u32, rgba) {
                let _ = img.save(file);
            }
            // Fecha de verdade, sem ir para a bandeja.
            crate::tray::QUITTING.store(true, std::sync::atomic::Ordering::Relaxed);
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        } else if ctx.input(|i| i.time) > 4.0 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
        }
        ctx.request_repaint();
    }
}

/// O pedaço da capa que enche a caixa sem deformar, como o `object-fit: cover` da versão em
/// Electron: sobra dos lados é cortada ao meio; sobra embaixo, do topo para baixo (o rosto fica).
fn cover_uv(image: Vec2, frame: Vec2) -> egui::Rect {
    let (img_ratio, box_ratio) = (image.x / image.y, frame.x / frame.y);
    if img_ratio > box_ratio {
        let w = box_ratio / img_ratio;
        egui::Rect::from_min_max(
            egui::pos2((1.0 - w) / 2.0, 0.0),
            egui::pos2((1.0 + w) / 2.0, 1.0),
        )
    } else {
        let h = img_ratio / box_ratio;
        egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, h))
    }
}

fn texture(ctx: &egui::Context, name: &str, image: &image::RgbaImage) -> TextureHandle {
    let size = [image.width() as usize, image.height() as usize];
    ctx.load_texture(
        name,
        ColorImage::from_rgba_unmultiplied(size, image.as_raw()),
        TextureOptions::LINEAR,
    )
}

fn jpeg_texture(ctx: &egui::Context, name: &str, jpeg: &[u8]) -> Option<TextureHandle> {
    let img = image::load_from_memory(jpeg)
        .ok()?
        .thumbnail(240, 340)
        .to_rgba8();
    Some(texture(ctx, name, &img))
}

impl App {
    // --- Biblioteca -----------------------------------------------------------------------------

    fn cover(&mut self, ctx: &egui::Context, work: &Work) -> Option<TextureHandle> {
        if let Some(t) = self.covers.get(&work.id) {
            return t.clone();
        }
        let jpeg = library::work_cover(&work.id).or_else(|| {
            let latest = self.entries.iter().find(|e| e.work_id == work.id)?;
            library::cover_of(&latest.id)
        });
        let tex = jpeg.and_then(|j| jpeg_texture(ctx, &work.id, &j));
        self.covers.insert(work.id.clone(), tex.clone());
        tex
    }

    /// O caminho pelo app, descendo pela esquerda como no MangaDex.
    fn sidebar(&mut self, ctx: &egui::Context) {
        let queued = self
            .queue
            .jobs
            .iter()
            .filter(|j| matches!(j.status, Status::Queued | Status::Running))
            .count();
        egui::SidePanel::left("nav")
            .exact_width(220.0)
            .resizable(false)
            .frame(
                egui::Frame::new()
                    .fill(theme::SIDEBAR)
                    .stroke(egui::Stroke::new(1.0_f32, theme::BORDER))
                    .inner_margin(egui::Margin::symmetric(10, 14)),
            )
            .show(ctx, |ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                let brand = ui.horizontal(|ui| {
                    ui.add_space(8.0);
                    if let Some(logo) = &self.logo {
                        ui.add(
                            egui::Image::new((logo.id(), Vec2::splat(30.0)))
                                .corner_radius(egui::CornerRadius::same(8)),
                        );
                    }
                    ui.label(theme::heading("Toon Index", 17.0));
                });
                if brand.response.interact(egui::Sense::click()).clicked() {
                    self.tab = Tab::Library;
                    self.selected = None;
                    self.reader = None;
                }
                ui.add_space(14.0);
                // A busca em pílula, como na versão em Electron.
                let search = egui::Button::new(
                    RichText::new("🔍  Buscar obra")
                        .color(theme::MUTED)
                        .size(13.0),
                )
                .fill(theme::PANEL)
                .stroke(egui::Stroke::new(1.0_f32, theme::BORDER))
                .corner_radius(egui::CornerRadius::same(255))
                .min_size(Vec2::new(ui.available_width(), 34.0));
                if ui.add(search).clicked() {
                    self.tab = Tab::Search;
                    self.reader = None;
                }
                ui.add_space(10.0);
                let mut go = None;
                if theme::nav_item(ui, "📚", "Biblioteca", self.tab == Tab::Library, 0) {
                    go = Some(Tab::Library);
                }
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    ui.add_space(12.0);
                    ui.label(theme::mono_label("Traduzir"));
                });
                ui.add_space(4.0);
                if theme::nav_item(ui, "📄", "Traduzir PDF", self.tab == Tab::Pdf, 0) {
                    go = Some(Tab::Pdf);
                }
                if theme::nav_item(ui, "⏳", "Fila", self.tab == Tab::Queue, queued) {
                    go = Some(Tab::Queue);
                }
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    ui.add_space(12.0);
                    ui.label(theme::mono_label("App"));
                });
                ui.add_space(4.0);
                if theme::nav_item(ui, "📱", "Celular", self.tab == Tab::Phone, 0) {
                    go = Some(Tab::Phone);
                }
                if theme::nav_item(ui, "⚙", "Configurações", self.tab == Tab::Settings, 0) {
                    go = Some(Tab::Settings);
                }
                if let Some(tab) = go {
                    if tab == Tab::Library && self.tab == Tab::Library {
                        self.selected = None;
                    }
                    self.tab = tab;
                    self.reader = None;
                }
            });
    }

    fn library(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if self.reader.is_some() {
            return self.reader_view(ui, ctx);
        }
        let records = reading::list();
        if let Some(work) = self
            .selected
            .as_ref()
            .and_then(|id| self.works.iter().find(|w| &w.id == id))
            .cloned()
        {
            if ui
                .add(
                    egui::Button::new(RichText::new("← Biblioteca").color(theme::MUTED))
                        .frame(false),
                )
                .clicked()
            {
                self.selected = None;
                return;
            }
            ui.add_space(8.0);
            return self.work_panel(ui, ctx, &work, &records);
        }
        let filter = toon_core::names::normalize_name(&self.filter);
        let mut works: Vec<Work> = self
            .works
            .iter()
            .filter(|w| {
                let has = self.entries.iter().any(|e| e.work_id == w.id)
                    || records.iter().any(|r| r.work_id == w.id)
                    || w.shelf.is_some();
                let shelf_ok = self.shelf.is_none_or(|s| {
                    w.shelf_of(records.iter().any(|r| r.work_id == w.id)) == Some(s)
                });
                let name_ok = filter.is_empty()
                    || w.names
                        .iter()
                        .any(|n| toon_core::names::normalize_name(n).contains(&filter));
                has && shelf_ok && name_ok
            })
            .cloned()
            .collect();
        let last_activity = |w: &Work| {
            let read = records
                .iter()
                .filter(|r| r.work_id == w.id)
                .map(|r| r.updated_at)
                .max()
                .unwrap_or(0);
            let saved = self
                .entries
                .iter()
                .filter(|e| e.work_id == w.id)
                .map(|e| e.created_at)
                .max()
                .unwrap_or(0);
            read.max(saved)
        };
        works.sort_by(|a, b| {
            b.favorite
                .cmp(&a.favorite)
                .then(last_activity(b).cmp(&last_activity(a)))
        });
        ui.horizontal(|ui| {
            ui.label(theme::heading("Biblioteca", 26.0));
            ui.add_space(6.0);
            ui.label(
                RichText::new(format!("{} obras", works.len()))
                    .family(egui::FontFamily::Monospace)
                    .color(theme::MUTED),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.filter)
                        .hint_text("Procurar na biblioteca")
                        .desired_width(260.0)
                        .margin(egui::Margin::symmetric(10, 7)),
                );
            });
        });
        ui.add_space(10.0);
        ui.horizontal_wrapped(|ui| {
            if theme::chip(ui, "Todas", self.shelf.is_none()) {
                self.shelf = None;
            }
            for s in Shelf::ALL {
                if theme::chip(ui, s.label(), self.shelf == Some(s)) {
                    self.shelf = Some(s);
                }
            }
        });
        ui.add_space(16.0);
        if works.is_empty() {
            ui.label(
                RichText::new("Nenhuma obra aqui ainda. Busque uma obra ou traduza um PDF.")
                    .color(theme::MUTED),
            );
            return;
        }
        egui::ScrollArea::vertical()
            .auto_shrink(false)
            .show(ui, |ui| {
                let gap = 16.0;
                let full = ui.available_width() - 4.0;
                let cols = ((full + gap) / (150.0 + gap)).floor().max(1.0) as usize;
                let width = (full - gap * (cols as f32 - 1.0)) / cols as f32;
                for row in works.chunks(cols) {
                    ui.horizontal_top(|ui| {
                        ui.spacing_mut().item_spacing.x = gap;
                        for w in row {
                            let read = records
                                .iter()
                                .filter(|r| r.work_id == w.id && r.status == ReadStatus::Read)
                                .map(|r| r.chapter)
                                .fold(f64::MIN, f64::max);
                            let count = self.entries.iter().filter(|e| e.work_id == w.id).count();
                            let mut info = Vec::new();
                            if read > f64::MIN {
                                info.push(format!("CAP. {}", jobs::number_text(read)));
                            }
                            if count > 0 {
                                info.push(format!("{count} NO PC"));
                            }
                            if self.poster_card(ui, ctx, w, width, &info.join(" · ")) {
                                self.selected = Some(w.id.clone());
                            }
                        }
                    });
                    ui.add_space(16.0);
                }
            });
    }

    /// Uma capa da grade, com o nome embaixo; `true` ao ser clicada.
    fn poster_card(
        &mut self,
        ui: &mut egui::Ui,
        ctx: &egui::Context,
        work: &Work,
        width: f32,
        info: &str,
    ) -> bool {
        let poster_h = width * 1.5;
        let (rect, response) =
            ui.allocate_exact_size(Vec2::new(width, poster_h + 62.0), egui::Sense::click());
        let lift = if response.hovered() { -3.0 } else { 0.0 };
        let poster =
            egui::Rect::from_min_size(rect.min + Vec2::new(0.0, lift), Vec2::new(width, poster_h));
        let painter = ui.painter_at(rect.expand(4.0));
        let radius = egui::CornerRadius::same(8);
        if response.hovered() {
            painter.rect_filled(
                poster.translate(Vec2::new(0.0, 6.0)).expand(2.0),
                radius,
                Color32::from_black_alpha(90),
            );
        }
        painter.rect_filled(poster, radius, theme::PANEL_2);
        match self.cover(ctx, work) {
            Some(t) => {
                egui::Image::new((t.id(), poster.size()))
                    .uv(cover_uv(t.size_vec2(), poster.size()))
                    .corner_radius(radius)
                    .paint_at(ui, poster);
            }
            None => {
                painter.text(
                    poster.center(),
                    egui::Align2::CENTER_CENTER,
                    "📖",
                    egui::FontId::proportional(34.0),
                    theme::MUTED,
                );
            }
        }
        if work.favorite {
            let star = egui::Rect::from_min_size(
                poster.right_top() + Vec2::new(-32.0, 8.0),
                Vec2::splat(24.0),
            );
            painter.rect_filled(
                star,
                egui::CornerRadius::same(12),
                Color32::from_black_alpha(160),
            );
            painter.text(
                star.center(),
                egui::Align2::CENTER_CENTER,
                "★",
                egui::FontId::proportional(13.0),
                theme::ACCENT,
            );
        }
        let mut job = egui::text::LayoutJob::simple(
            display_name(work.name()),
            egui::FontId::new(14.0, theme::bold()),
            theme::TEXT,
            width,
        );
        job.wrap.max_rows = 2;
        let title = painter.layout_job(job);
        let title_h = title.size().y;
        painter.galley(
            poster.left_bottom() + Vec2::new(0.0, 6.0),
            title,
            theme::TEXT,
        );
        if !info.is_empty() {
            painter.text(
                poster.left_bottom() + Vec2::new(0.0, 10.0 + title_h),
                egui::Align2::LEFT_TOP,
                info,
                egui::FontId::monospace(11.0),
                theme::MUTED,
            );
        }
        response
            .on_hover_cursor(egui::CursorIcon::PointingHand)
            .clicked()
    }

    fn work_panel(
        &mut self,
        ui: &mut egui::Ui,
        ctx: &egui::Context,
        work: &Work,
        records: &[reading::Record],
    ) {
        // A ficha da obra num painel, com a capa ao lado, como a página da obra na versão em Electron.
        let cover = self.cover(ctx, work);
        egui::Frame::new()
            .fill(theme::PANEL)
            .stroke(egui::Stroke::new(1.0_f32, theme::BORDER))
            .corner_radius(egui::CornerRadius::same(16))
            .inner_margin(egui::Margin::same(26))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal_top(|ui| {
                    let poster = Vec2::new(190.0, 285.0);
                    match &cover {
                        Some(t) => {
                            ui.add(
                                egui::Image::new((t.id(), poster))
                                    .uv(cover_uv(t.size_vec2(), poster))
                                    .corner_radius(egui::CornerRadius::same(8)),
                            );
                        }
                        None => {
                            let (rect, _) = ui.allocate_exact_size(poster, egui::Sense::hover());
                            ui.painter().rect_filled(
                                rect,
                                egui::CornerRadius::same(8),
                                theme::PANEL_2,
                            );
                        }
                    }
                    ui.add_space(14.0);
                    ui.vertical(|ui| {
                        ui.label(theme::heading(display_name(work.name()), 32.0));
                        if work.names.len() > 1 {
                            ui.label(
                                RichText::new(work.names[1..].join(" · ")).color(theme::MUTED),
                            );
                        }
                        ui.add_space(6.0);
                        let mut tags: Vec<String> = Vec::new();
                        if let Some(info) = &work.info {
                            tags.extend(info.status.clone());
                            tags.extend(info.year.map(|y| y.to_string()));
                            tags.extend(info.tags.clone().unwrap_or_default());
                        }
                        if work.favorite {
                            tags.insert(0, "★ Favorita".into());
                        }
                        if !tags.is_empty() {
                            ui.horizontal_wrapped(|ui| {
                                ui.spacing_mut().item_spacing = Vec2::new(6.0, 6.0);
                                for t in &tags {
                                    egui::Frame::new()
                                        .fill(Color32::from_white_alpha(26))
                                        .corner_radius(egui::CornerRadius::same(5))
                                        .inner_margin(egui::Margin::symmetric(8, 3))
                                        .show(ui, |ui| {
                                            ui.label(
                                                RichText::new(t.to_uppercase())
                                                    .family(egui::FontFamily::Monospace)
                                                    .size(11.0)
                                                    .color(theme::TEXT),
                                            );
                                        });
                                }
                            });
                            ui.add_space(6.0);
                        }
                        if let Some(synopsis) = work.info.as_ref().and_then(|i| i.synopsis.clone())
                        {
                            ui.label(RichText::new(synopsis).color(Color32::from_gray(0xd6)));
                            ui.add_space(6.0);
                        }
                        ui.horizontal_wrapped(|ui| {
                            let mut shelf = work.shelf;
                            egui::ComboBox::from_id_salt("shelf")
                                .selected_text(shelf.map_or("Sem lista", |s| s.label()))
                                .show_ui(ui, |ui| {
                                    ui.selectable_value(&mut shelf, None, "Sem lista");
                                    for s in Shelf::ALL {
                                        ui.selectable_value(&mut shelf, Some(s), s.label());
                                    }
                                });
                            if shelf != work.shelf {
                                let _ = library::set_work_shelf(&work.id, Some(shelf), None);
                                self.reload();
                            }
                            if ui
                                .button(if work.favorite {
                                    "★ Favorita"
                                } else {
                                    "☆ Favoritar"
                                })
                                .clicked()
                            {
                                let _ =
                                    library::set_work_shelf(&work.id, None, Some(!work.favorite));
                                self.reload();
                            }
                            if let Some(source) = work.sources().first()
                                && ui.button("Abrir no site").clicked()
                            {
                                let _ = open::that(source);
                            }
                            if let Some(done) = self.refreshing.as_ref().and_then(Pending::take) {
                                self.refreshing = None;
                                self.notice = match done {
                                    Ok(()) => "Dados da obra atualizados.".into(),
                                    Err(e) => e,
                                };
                                self.covers.remove(&work.id);
                                self.reload();
                            }
                            if self.refreshing.is_some() {
                                ui.spinner();
                            } else if ui.button("Atualizar dados").clicked() {
                                let id = work.id.clone();
                                self.refreshing =
                                    Some(Pending::spawn(&self.runtime, ctx, async move {
                                        toon_web::details::refresh_work(&id)
                                            .await
                                            .map(|_| ())
                                            .map_err(|e| e.to_string())
                                    }));
                            }
                            let mut auto = work.auto;
                            egui::ComboBox::from_id_salt("auto")
                                .selected_text(match auto {
                                    None => "Capítulo novo: só avisar",
                                    Some(toon_core::works::Auto::Translate) => {
                                        "Capítulo novo: traduzir"
                                    }
                                    Some(toon_core::works::Auto::Download) => {
                                        "Capítulo novo: baixar"
                                    }
                                })
                                .show_ui(ui, |ui| {
                                    ui.selectable_value(&mut auto, None, "Só avisar");
                                    ui.selectable_value(
                                        &mut auto,
                                        Some(toon_core::works::Auto::Translate),
                                        "Traduzir sozinho",
                                    );
                                    ui.selectable_value(
                                        &mut auto,
                                        Some(toon_core::works::Auto::Download),
                                        "Baixar sozinho",
                                    );
                                });
                            if auto != work.auto {
                                let _ = library::set_work_auto(&work.id, auto);
                                self.reload();
                            }
                        });
                    });
                });
            });
        ui.add_space(22.0);
        ui.label(theme::heading("Capítulos", 20.0));
        ui.add_space(8.0);
        let mut entries: Vec<Entry> = self
            .entries
            .iter()
            .filter(|e| e.work_id == work.id)
            .cloned()
            .collect();
        entries.sort_by(|a, b| {
            b.chapter
                .unwrap_or(0.0)
                .total_cmp(&a.chapter.unwrap_or(0.0))
        });
        let read: Vec<f64> = records
            .iter()
            .filter(|r| r.work_id == work.id && r.status == ReadStatus::Read)
            .map(|r| r.chapter)
            .collect();
        egui::ScrollArea::vertical().show(ui, |ui| {
            for e in entries {
                ui.horizontal(|ui| {
                    let number = e
                        .chapter
                        .map(jobs::number_text)
                        .unwrap_or_else(|| "?".into());
                    let done = e.chapter.is_some_and(|c| read.contains(&c));
                    let label = format!(
                        "{} {number}",
                        if work.is_volumes() {
                            "Volume"
                        } else {
                            "Capítulo"
                        }
                    );
                    ui.label(if done {
                        RichText::new(label).weak()
                    } else {
                        RichText::new(label).strong()
                    });
                    ui.label(
                        RichText::new(if e.downloaded() {
                            "baixado".to_string()
                        } else {
                            format!("traduzido · {}", e.model)
                        })
                        .weak(),
                    );
                    if ui.button("Ler").clicked() {
                        self.open_reader(ctx, &e);
                    }
                    if ui.button("PDF").clicked() {
                        let _ = open::that(e.pdf(true));
                    }
                    if let Some(c) = e.chapter {
                        if done {
                            if ui.small_button("Não lido").clicked() {
                                let _ = reading::forget(&work.id, Some(&[c]));
                            }
                        } else if ui.small_button("Lido").clicked() {
                            let _ = reading::mark_read(&work.id, &[c]);
                        }
                    }
                    if ui.small_button("Apagar").clicked() {
                        let _ = library::delete_from_library(&e.id);
                        self.reload();
                    }
                });
            }
        });
    }

    fn open_reader(&mut self, ctx: &egui::Context, e: &Entry) {
        let path = e.pdf(true);
        let pages = Pending::spawn(&self.runtime, ctx, async move {
            tokio::task::spawn_blocking(move || -> Result<Vec<image::RgbaImage>, String> {
                let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
                let pages = toon_page::pdf::read_pages(&bytes).map_err(|e| e.to_string())?;
                // Lido na largura de uma tela: imagens enormes não cabem numa textura.
                Ok(pages
                    .into_iter()
                    .map(|p| {
                        p.image
                            .resize(900, 16_000, image::imageops::FilterType::Triangle)
                            .to_rgba8()
                    })
                    .collect())
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()))
        });
        let _ = reading::read_in_app(&e.id, 0.0, None);
        self.reader = Some(Reader {
            title: e.title.clone(),
            pages,
            textures: Vec::new(),
            error: None,
        });
        self.selected_entry = Some(e.id.clone());
    }

    fn reader_view(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let Some(reader) = self.reader.as_mut() else {
            return;
        };
        if let Some(result) = reader.pages.take() {
            match result {
                Ok(images) => {
                    reader.textures = images
                        .iter()
                        .enumerate()
                        .map(|(i, img)| texture(ctx, &format!("page{i}"), img))
                        .collect()
                }
                Err(e) => reader.error = Some(e),
            }
        }
        let mut close = false;
        ui.horizontal(|ui| {
            if ui.button("← Voltar").clicked() {
                close = true;
            }
            ui.heading(&reader.title);
        });
        if let Some(e) = &reader.error {
            ui.colored_label(theme::ERR, e);
        } else if reader.textures.is_empty() {
            ui.spinner();
        }
        let mut finished = false;
        egui::ScrollArea::vertical()
            .auto_shrink(false)
            .show(ui, |ui| {
                let width = ui.available_width().min(900.0);
                ui.vertical_centered(|ui| {
                    for t in &reader.textures {
                        let size = t.size_vec2();
                        ui.add(egui::Image::new((
                            t.id(),
                            Vec2::new(width, size.y * width / size.x),
                        )));
                    }
                    if !reader.textures.is_empty() {
                        let end = ui.label(RichText::new("Fim do capítulo").weak());
                        finished = ui.is_rect_visible(end.rect);
                    }
                });
            });
        if finished && let Some(id) = &self.selected_entry {
            let _ = reading::read_in_app(id, 1.0, None);
        }
        if close {
            self.reader = None;
            self.reload();
        }
    }
}
