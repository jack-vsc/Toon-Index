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

const ACCENT: Color32 = Color32::from_rgb(0xe8, 0x5d, 0x75);

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
        let mut style = (*cc.egui_ctx.style()).clone();
        style.visuals = egui::Visuals::dark();
        style.visuals.selection.bg_fill = ACCENT;
        style.spacing.item_spacing = Vec2::new(8.0, 6.0);
        cc.egui_ctx.set_style(style);
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
        self.screenshot(ctx);
        if std::mem::take(&mut *self.engine.dirty.lock()) {
            self.reload();
        }
        // A fila anda sozinha: a janela olha de vez em quando.
        ctx.request_repaint_after(std::time::Duration::from_secs(2));
        if self.queue.jobs.iter().any(|j| j.status == Status::Running) {
            self.queue = jobs::queue();
        }
        egui::TopBottomPanel::top("tabs").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new("Toon Index")
                        .strong()
                        .color(ACCENT)
                        .size(18.0),
                );
                ui.separator();
                for (tab, label) in [
                    (Tab::Library, "Biblioteca"),
                    (Tab::Search, "Buscar obra"),
                    (Tab::Queue, "Fila"),
                    (Tab::Pdf, "Traduzir PDF"),
                    (Tab::Phone, "Celular"),
                    (Tab::Settings, "Configurações"),
                ] {
                    let queued = self
                        .queue
                        .jobs
                        .iter()
                        .filter(|j| matches!(j.status, Status::Queued | Status::Running))
                        .count();
                    let text = if tab == Tab::Queue && queued > 0 {
                        format!("{label} ({queued})")
                    } else {
                        label.to_string()
                    };
                    if ui.selectable_label(self.tab == tab, text).clicked() {
                        self.tab = tab;
                        self.reader = None;
                    }
                }
            });
        });
        egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
            ui.horizontal(|ui| {
                let status = self.engine.status.lock().clone();
                ui.label(
                    RichText::new(if self.notice.is_empty() {
                        status
                    } else {
                        self.notice.clone()
                    })
                    .weak(),
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
        egui::CentralPanel::default().show(ctx, |ui| match self.tab {
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
            if self.selected.is_none() {
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
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        } else if ctx.input(|i| i.time) > 4.0 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
        }
        ctx.request_repaint();
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

    fn library(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if self.reader.is_some() {
            return self.reader_view(ui, ctx);
        }
        let records = reading::list();
        ui.horizontal(|ui| {
            ui.add(
                egui::TextEdit::singleline(&mut self.filter)
                    .hint_text("Procurar na biblioteca")
                    .desired_width(260.0),
            );
            ui.selectable_value(&mut self.shelf, None, "Todas");
            for s in Shelf::ALL {
                ui.selectable_value(&mut self.shelf, Some(s), s.label());
            }
        });
        ui.separator();
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
        egui::SidePanel::left("works")
            .resizable(true)
            .default_width(420.0)
            .show_inside(ui, |ui| {
                egui::ScrollArea::vertical().show(ui, |ui| {
                    for w in &works {
                        let read = records
                            .iter()
                            .filter(|r| r.work_id == w.id && r.status == ReadStatus::Read)
                            .map(|r| r.chapter)
                            .fold(f64::MIN, f64::max);
                        let count = self.entries.iter().filter(|e| e.work_id == w.id).count();
                        let cover = self.cover(ctx, w);
                        let selected = self.selected.as_deref() == Some(&w.id);
                        let row = ui.horizontal(|ui| {
                            if let Some(t) = &cover {
                                ui.add(egui::Image::new((t.id(), Vec2::new(46.0, 64.0))));
                            } else {
                                ui.add_sized([46.0, 64.0], egui::Label::new("📖"));
                            }
                            ui.vertical(|ui| {
                                let name = display_name(w.name());
                                let title = if w.favorite {
                                    format!("★ {name}")
                                } else {
                                    name
                                };
                                if ui
                                    .selectable_label(selected, RichText::new(title).strong())
                                    .clicked()
                                {
                                    self.selected = Some(w.id.clone());
                                }
                                let mut info = Vec::new();
                                if read > f64::MIN {
                                    info.push(format!("lido até {}", jobs::number_text(read)));
                                }
                                if count > 0 {
                                    info.push(format!("{count} no PC"));
                                }
                                if let Some(s) = w.shelf {
                                    info.push(s.label().to_string());
                                }
                                ui.label(RichText::new(info.join(" · ")).weak());
                            });
                        });
                        if row.response.interact(egui::Sense::click()).clicked() {
                            self.selected = Some(w.id.clone());
                        }
                    }
                    if works.is_empty() {
                        ui.label("Nenhuma obra aqui ainda. Busque uma obra ou traduza um PDF.");
                    }
                });
            });
        let Some(work) = self
            .selected
            .as_ref()
            .and_then(|id| self.works.iter().find(|w| &w.id == id))
            .cloned()
        else {
            ui.centered_and_justified(|ui| ui.label("Escolha uma obra à esquerda."));
            return;
        };
        self.work_panel(ui, ctx, &work, &records);
    }

    fn work_panel(
        &mut self,
        ui: &mut egui::Ui,
        ctx: &egui::Context,
        work: &Work,
        records: &[reading::Record],
    ) {
        ui.heading(display_name(work.name()));
        if work.names.len() > 1 {
            ui.label(RichText::new(work.names[1..].join(" · ")).weak());
        }
        ui.horizontal(|ui| {
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
                let _ = library::set_work_shelf(&work.id, None, Some(!work.favorite));
                self.reload();
            }
            if let Some(source) = work.sources().first()
                && ui.button("Abrir no site").clicked()
            {
                let _ = open::that(source);
            }
        });
        if let Some(synopsis) = work.info.as_ref().and_then(|i| i.synopsis.clone()) {
            ui.label(RichText::new(synopsis).weak());
        }
        ui.separator();
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
            ui.colored_label(Color32::LIGHT_RED, e);
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
