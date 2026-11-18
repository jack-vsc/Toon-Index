//! As abas além da biblioteca: busca nos sites, fila, PDFs, celular e configurações.

use super::*;

impl App {
    // --- Buscar obra ----------------------------------------------------------------------------

    pub(super) fn search(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if let Some(r) = self.searching.as_ref().and_then(Pending::take) {
            self.results = r;
            self.searching = None;
        }
        if let Some(r) = self.listing.as_ref().and_then(Pending::take) {
            self.listing = None;
            match r {
                Ok(list) => {
                    self.from = list.chapters.first().map_or(0.0, |c| c.chapter);
                    self.to = list.chapters.last().map_or(0.0, |c| c.chapter);
                    self.chapters = Some(list);
                }
                Err(e) => self.notice = e,
            }
        }
        ui.horizontal(|ui| {
            let field = ui.add(
                egui::TextEdit::singleline(&mut self.query)
                    .hint_text("Nome da obra ou link da página dela")
                    .desired_width(420.0),
            );
            let go = ui
                .add_enabled(self.searching.is_none(), egui::Button::new("Buscar"))
                .clicked()
                || (field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)));
            if go && !self.query.trim().is_empty() {
                let q = self.query.trim().to_string();
                self.picked = None;
                self.chapters = None;
                if q.starts_with("http") {
                    // Um link de obra colado vai direto para a lista de capítulos.
                    let m = Match {
                        site: catalog::Site::of_url(&q),
                        title: String::new(),
                        url: q.clone(),
                        cover: None,
                        alt_names: Vec::new(),
                        latest: None,
                        pt_names: Vec::new(),
                    };
                    self.pick(ctx, m);
                } else {
                    self.searching = Some(Pending::spawn(&self.runtime, ctx, async move {
                        catalog::search(&q).await
                    }));
                }
            }
            if self.searching.is_some() || self.listing.is_some() {
                ui.spinner();
            }
        });
        ui.label(RichText::new("MangaDex, mgeko, MangaKakalot e MangaLivre. Quando um site pedir verificação, a janela do navegador aparece para você confirmar.").weak());
        ui.separator();
        egui::SidePanel::left("results")
            .resizable(true)
            .default_width(420.0)
            .show_inside(ui, |ui| {
                egui::ScrollArea::vertical().show(ui, |ui| {
                    let mut chosen = None;
                    for r in &self.results {
                        ui.label(RichText::new(r.site.label()).strong().color(ACCENT));
                        if let Some(e) = &r.error {
                            ui.colored_label(theme::ERR, e);
                        }
                        if r.matches.is_empty() && r.error.is_none() {
                            ui.label(RichText::new("Nada encontrado.").weak());
                        }
                        for m in &r.matches {
                            let latest = m
                                .latest
                                .map(|l| format!(" · cap. {}", jobs::number_text(l)))
                                .unwrap_or_default();
                            if ui
                                .selectable_label(
                                    self.picked.as_ref().is_some_and(|p| p.url == m.url),
                                    format!("{}{latest}", m.title),
                                )
                                .clicked()
                            {
                                chosen = Some(m.clone());
                            }
                        }
                        ui.add_space(6.0);
                    }
                    if let Some(m) = chosen {
                        self.pick(ctx, m);
                    }
                });
            });
        let Some(list) = self.chapters.clone() else {
            ui.centered_and_justified(|ui| ui.label("Escolha um resultado para ver os capítulos."));
            return;
        };
        let title = self
            .picked
            .as_ref()
            .map(|m| m.title.clone())
            .filter(|t| !t.is_empty())
            .or(list.title.clone())
            .unwrap_or_default();
        ui.heading(&title);
        ui.label(format!("{} capítulos", list.chapters.len()));
        let portuguese = list
            .language
            .as_deref()
            .is_some_and(|l| l.to_lowercase().starts_with("pt"));
        if portuguese {
            ui.label(
                RichText::new(
                    "Este site já está em português: os capítulos são baixados como estão.",
                )
                .weak(),
            );
        }
        ui.horizontal(|ui| {
            ui.label("Do capítulo");
            ui.add(egui::DragValue::new(&mut self.from).speed(1.0));
            ui.label("ao");
            ui.add(egui::DragValue::new(&mut self.to).speed(1.0));
        });
        let picked: Vec<BatchChapter> = list
            .chapters
            .iter()
            .filter(|c| c.chapter >= self.from && c.chapter <= self.to)
            .map(|c| BatchChapter {
                chapter: c.chapter,
                url: c.url.clone(),
            })
            .collect();
        ui.horizontal(|ui| {
            let site = self
                .picked
                .as_ref()
                .map(|m| {
                    serde_json::to_value(m.site)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            let work = if title.is_empty() {
                "Sem nome".to_string()
            } else {
                title.clone()
            };
            if !portuguese
                && ui
                    .add(theme::primary(&format!(
                        "Traduzir {} capítulos",
                        picked.len()
                    )))
                    .clicked()
            {
                self.queue_batch(&work, &site, &picked, false);
            }
            if ui
                .button(format!("Baixar {} sem traduzir", picked.len()))
                .clicked()
            {
                self.queue_batch(&work, &site, &picked, true);
            }
        });
        ui.separator();
        egui::ScrollArea::vertical().show(ui, |ui| {
            for c in list.chapters.iter().rev() {
                ui.horizontal(|ui| {
                    ui.label(format!("Capítulo {}", jobs::number_text(c.chapter)));
                    if ui.small_button("abrir").clicked() {
                        let _ = open::that(&c.url);
                    }
                });
            }
        });
    }

    fn pick(&mut self, ctx: &egui::Context, m: Match) {
        let (site, url) = (m.site, m.url.clone());
        self.picked = Some(m);
        self.chapters = None;
        self.listing = Some(Pending::spawn(&self.runtime, ctx, async move {
            catalog::chapter_list(site, &url)
                .await
                .map_err(|e| e.to_string())
        }));
    }

    fn queue_batch(&mut self, work: &str, site: &str, chapters: &[BatchChapter], download: bool) {
        match jobs::add_batch(work, site, chapters, download, "PC", None) {
            Ok(q) => {
                self.queue = q;
                if let Some(url) = self.picked.as_ref().map(|m| m.url.clone()) {
                    let _ = library::add_work_source(work, &url);
                }
                self.notice = format!("{} capítulos na fila.", chapters.len());
            }
            Err(e) => self.notice = e.to_string(),
        }
    }

    // --- Fila -------------------------------------------------------------------------------------

    pub(super) fn queue_tab(&mut self, ui: &mut egui::Ui) {
        ui.heading("Fila");
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            let paused = self.queue.paused;
            if ui
                .button(if paused {
                    "▶ Continuar a fila"
                } else {
                    "⏸ Pausar a fila"
                })
                .clicked()
                && let Ok(q) = jobs::pause(!paused)
            {
                self.queue = q;
            }
            let failed = self
                .queue
                .jobs
                .iter()
                .filter(|j| j.status == Status::Failed)
                .count();
            if failed > 0 && ui.button(format!("Tentar de novo ({failed})")).clicked() {
                let ids: Vec<String> = self
                    .queue
                    .jobs
                    .iter()
                    .filter(|j| j.status == Status::Failed)
                    .map(|j| j.id.clone())
                    .collect();
                if let Ok(q) = jobs::retry(Some(&ids)) {
                    self.queue = q;
                }
            }
            if ui.button("Ordenar por capítulo").clicked()
                && let Ok(q) = jobs::sort()
            {
                self.queue = q;
            }
            if ui.button("Limpar faixas paradas").clicked()
                && let Ok(q) = jobs::clear_batch()
            {
                self.queue = q;
            }
        });
        ui.separator();
        let mut cancel = None;
        let mut retry = None;
        egui::ScrollArea::vertical().show(ui, |ui| {
            let mut jobs = self.queue.jobs.clone();
            jobs.sort_by_key(|j| match j.status {
                Status::Running => 0,
                Status::Queued => 1,
                Status::Failed => 2,
                Status::Done => 3,
            });
            for j in &jobs {
                ui.horizontal(|ui| {
                    let (label, color) = match j.status {
                        Status::Running => ("traduzindo", ACCENT),
                        Status::Queued => ("na fila", Color32::GRAY),
                        Status::Failed => ("falhou", theme::ERR),
                        Status::Done => ("pronto", theme::OK),
                    };
                    ui.colored_label(color, label);
                    ui.label(RichText::new(&j.name).strong());
                    if j.batch.as_ref().is_some_and(|b| b.download) {
                        ui.label(RichText::new("baixar").weak());
                    }
                    if let Some(p) = &j.progress
                        && p.total > 0
                    {
                        ui.add(
                            egui::ProgressBar::new(p.done as f32 / p.total as f32)
                                .desired_width(160.0)
                                .text(format!("{}/{}", p.done, p.total)),
                        );
                    }
                    if let Some(m) = &j.message {
                        ui.label(RichText::new(m).weak());
                    }
                    match j.status {
                        Status::Queued | Status::Running
                            if ui.small_button("Cancelar").clicked() =>
                        {
                            cancel = Some(j.id.clone())
                        }
                        Status::Failed if ui.small_button("De novo").clicked() => {
                            retry = Some(j.id.clone())
                        }
                        _ => {}
                    }
                });
            }
            if jobs.is_empty() {
                ui.label("A fila está vazia.");
            }
        });
        if let Some(id) = cancel {
            self.engine.cancel(&id);
            if let Ok(q) = jobs::cancel(&id) {
                self.queue = q;
            }
        }
        if let Some(id) = retry
            && let Ok(q) = jobs::retry(Some(&[id]))
        {
            self.queue = q;
        }
    }

    // --- Traduzir PDF -----------------------------------------------------------------------------

    pub(super) fn pdf_tab(&mut self, ui: &mut egui::Ui) {
        ui.heading("Traduzir PDFs");
        ui.label("Os PDFs entram na fila com as configurações atuais. O nome do arquivo diz a obra e o capítulo (\"Obra Chapter 12.pdf\").");
        if ui.button("Escolher PDFs…").clicked()
            && let Some(files) = rfd::FileDialog::new()
                .add_filter("PDF", &["pdf"])
                .pick_files()
        {
            let mut added = 0;
            for f in files {
                let name = f
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                match std::fs::read(&f)
                    .map_err(anyhow::Error::from)
                    .and_then(|b| jobs::add_pdf(&name, &b, "PC", None))
                {
                    Ok(_) => added += 1,
                    Err(e) => self.notice = format!("{name}: {e}"),
                }
            }
            self.queue = jobs::queue();
            if added > 0 {
                self.notice = format!("{added} PDFs na fila.");
                self.tab = Tab::Queue;
            }
        }
        ui.add_space(12.0);
        ui.heading("Um capítulo por link");
        ui.horizontal(|ui| {
            ui.add(
                egui::TextEdit::singleline(&mut self.query)
                    .hint_text("Link da página de leitura do capítulo")
                    .desired_width(420.0),
            );
            if ui.add(theme::primary("Traduzir")).clicked() {
                match jobs::add_link(self.query.trim(), "PC", None) {
                    Ok(_) => {
                        self.queue = jobs::queue();
                        self.tab = Tab::Queue;
                    }
                    Err(e) => self.notice = e.to_string(),
                }
            }
        });
    }

    // --- Celular ----------------------------------------------------------------------------------

    pub(super) fn phone(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.heading("Celular");
        let mut enabled = devices::phones_enabled();
        if ui
            .checkbox(
                &mut enabled,
                "Atender o celular na rede de casa (e no Tailscale)",
            )
            .changed()
        {
            let _ = devices::set_phones_enabled(enabled);
            self.notice = "Reinicie o app para o servidor ouvir na rede.".into();
        }
        let addresses = devices::addresses();
        ui.label(format!(
            "Endereços: {}  ·  porta {}",
            addresses
                .iter()
                .map(|a| format!("{} ({})", a.address, a.kind))
                .collect::<Vec<_>>()
                .join(", "),
            toon_server::PORT
        ));
        ui.add_space(8.0);
        if ui.button("Parear um celular").clicked() {
            let code = devices::new_pairing_code(toon_server::PORT);
            if let Ok(qr) = qrcode::QrCode::new(code.qr_text.as_bytes()) {
                let modules = qr.to_colors();
                let side = qr.width();
                let scale = 6;
                let border = 4;
                let size = (side + 2 * border) * scale;
                let mut img = image::RgbaImage::from_pixel(
                    size as u32,
                    size as u32,
                    image::Rgba([255, 255, 255, 255]),
                );
                for (i, c) in modules.iter().enumerate() {
                    if *c == qrcode::Color::Dark {
                        let (x, y) = ((i % side + border) * scale, (i / side + border) * scale);
                        for dy in 0..scale {
                            for dx in 0..scale {
                                img.put_pixel(
                                    (x + dx) as u32,
                                    (y + dy) as u32,
                                    image::Rgba([0, 0, 0, 255]),
                                );
                            }
                        }
                    }
                }
                self.pairing = Some((code.code, texture(ctx, "qr", &img)));
            }
        }
        if let Some((code, qr)) = &self.pairing {
            ui.label(RichText::new(format!("Código: {code}")).size(22.0).strong());
            ui.label("No app do celular, leia o QR ou digite o código. Vale por 10 minutos.");
            ui.add(egui::Image::new((qr.id(), Vec2::splat(240.0))));
        }
        ui.separator();
        ui.label(RichText::new("Pareados").strong());
        for d in devices::list() {
            ui.horizontal(|ui| {
                ui.label(&d.name);
                if ui.small_button("Remover").clicked() {
                    let _ = devices::revoke(&d.id);
                }
            });
        }
    }

    // --- Configurações ------------------------------------------------------------------------------

    pub(super) fn settings_tab(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if let Some(r) = self.testing.as_ref().and_then(Pending::take) {
            self.test_result = r;
            self.testing = None;
        }
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.heading("APIs de tradução");
            let mut remove = None;
            for (i, p) in self.settings.profiles.iter_mut().enumerate() {
                ui.add_space(4.0);
                theme::card(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.radio_value(&mut self.settings.active_profile_id, p.id.clone(), "");
                        ui.add(egui::TextEdit::singleline(&mut p.name).desired_width(160.0));
                        if p.kind == ProviderKind::Cursor {
                            ui.colored_label(
                                theme::ERR,
                                "Cursor não funciona nesta versão",
                            );
                        }
                        if ui.small_button("Remover").clicked() {
                            remove = Some(i);
                        }
                    });
                    ui.horizontal(|ui| {
                        ui.label("URL base");
                        ui.add(
                            egui::TextEdit::singleline(&mut p.base_url)
                                .desired_width(320.0)
                                .hint_text("https://openrouter.ai/api/v1"),
                        );
                    });
                    ui.horizontal(|ui| {
                        ui.label("Modelo");
                        ui.add(egui::TextEdit::singleline(&mut p.model).desired_width(320.0));
                    });
                    ui.horizontal(|ui| {
                        ui.label("Chave");
                        let key = self.keys.entry(p.id.clone()).or_default();
                        let hint = self
                            .hints
                            .get(&p.id)
                            .map(|h| format!("guardada (…{h})"))
                            .unwrap_or_else(|| "sem chave".into());
                        ui.add(
                            egui::TextEdit::singleline(key)
                                .password(true)
                                .desired_width(320.0)
                                .hint_text(hint),
                        );
                    });
                    if p.is_anthropic() {
                        let mut level = p.thinking.unwrap_or_default();
                        egui::ComboBox::from_id_salt(format!("think{i}"))
                            .selected_text(format!("Raciocínio: {level:?}"))
                            .show_ui(ui, |ui| {
                                for t in [
                                    Thinking::Off,
                                    Thinking::Low,
                                    Thinking::Medium,
                                    Thinking::High,
                                ] {
                                    ui.selectable_value(&mut level, t, format!("{t:?}"));
                                }
                            });
                        p.thinking = (level != Thinking::Off).then_some(level);
                    }
                    if ui.button("Testar").clicked() && self.testing.is_none() {
                        let profile = p.clone();
                        let typed = self.keys.get(&p.id).cloned().filter(|k| !k.is_empty());
                        self.testing = Some(Pending::spawn(&self.runtime, ctx, async move {
                            match toon_ai::test_api(&profile, typed).await {
                                Ok(ms) => format!("\"{}\" respondeu em {ms} ms.", profile.name),
                                Err(e) => e.to_string(),
                            }
                        }));
                    }
                });
            }
            if let Some(i) = remove {
                self.settings.profiles.remove(i);
            }
            if ui.button("+ Adicionar API").clicked() {
                let id = format!("api-{}", toon_core::now_ms());
                self.settings.profiles.push(ApiProfile {
                    id,
                    name: "Nova API".into(),
                    base_url: "https://openrouter.ai/api/v1".into(),
                    ..Default::default()
                });
            }
            if self.testing.is_some() {
                ui.spinner();
            } else if !self.test_result.is_empty() {
                ui.label(&self.test_result);
            }
            ui.separator();
            ui.heading("Tradução");
            ui.horizontal(|ui| {
                language_combo(ui, "De", &mut self.settings.source_language, true);
                language_combo(ui, "Para", &mut self.settings.target_language, false);
            });
            ui.horizontal(|ui| {
                ui.label("Páginas ao mesmo tempo");
                ui.add(egui::Slider::new(&mut self.settings.concurrency, 1..=8));
            });
            ui.horizontal(|ui| {
                ui.label("Velocidade");
                ui.selectable_value(&mut self.settings.speed, Speed::Fast, "Rápida");
                ui.selectable_value(&mut self.settings.speed, Speed::Balanced, "Equilibrada");
                ui.selectable_value(&mut self.settings.speed, Speed::Quality, "Qualidade");
            });
            ui.checkbox(&mut self.settings.translate_sfx, "Traduzir onomatopeias");
            ui.checkbox(
                &mut self.settings.reuse_layers,
                "Reaproveitar páginas já traduzidas (camadas)",
            );
            ui.horizontal(|ui| {
                ui.label("PDFs são");
                ui.selectable_value(
                    &mut self.settings.content_type,
                    settings::ContentType::Auto,
                    "Detectar",
                );
                ui.selectable_value(
                    &mut self.settings.content_type,
                    settings::ContentType::Comic,
                    "Quadrinhos",
                );
                ui.selectable_value(
                    &mut self.settings.content_type,
                    settings::ContentType::Novel,
                    "Novels (texto)",
                );
            });
            ui.label(RichText::new("Servidor de visão (Python)").strong());
            ui.label("Acha balões e letras com redes treinadas em mangá e apaga o texto com o LaMa. A pasta tem o .venv e models/pretrained; vazia, o app usa o detector próprio.");
            ui.horizontal(|ui| {
                ui.label("Pasta");
                ui.add(
                    egui::TextEdit::singleline(&mut self.settings.vision_dir)
                        .desired_width(320.0)
                        .hint_text(r"D:\vision"),
                );
                ui.selectable_value(&mut self.settings.vision_device, "gpu".to_string(), "Placa de vídeo");
                ui.selectable_value(&mut self.settings.vision_device, "cpu".to_string(), "Processador");
            });
            if !self.settings.vision_dir.trim().is_empty() {
                match toon_page::vision::status() {
                    Ok(s) => ui.label(s),
                    Err(e) => ui.colored_label(theme::ERR, e),
                };
            }
            ui.horizontal(|ui| {
                ui.label("Pular páginas no começo");
                ui.add(egui::DragValue::new(&mut self.settings.skip_start).range(0..=50));
                ui.label("e no fim");
                ui.add(egui::DragValue::new(&mut self.settings.skip_end).range(0..=50));
            });
            ui.separator();
            ui.horizontal(|ui| {
                if ui.add(theme::primary("Salvar")).clicked() {
                    match settings::save(self.settings.clone(), &self.keys) {
                        Ok(s) => {
                            self.settings = s;
                            self.keys.clear();
                            self.hints = settings::key_hints();
                            self.notice = "Configurações salvas.".into();
                        }
                        Err(e) => self.notice = e.to_string(),
                    }
                }
                if ui.button("Contas dos sites (site-logins.env)").clicked() {
                    let _ = open::that(toon_web::logins::ensure_file());
                }
                if ui.button("Importar histórico dos navegadores").clicked() {
                    let (works, problems) = toon_core::history::scan();
                    self.history_pick = vec![true; works.len()];
                    self.history = Some(works);
                    if !problems.is_empty() {
                        self.notice = problems.join(" ");
                    }
                }
                if ui.button("Espaço em disco").clicked() {
                    self.storage = Some(toon_core::storage::usage());
                }
                if ui.button("Pasta de dados").clicked() {
                    let _ = open::that(toon_core::paths::data_dir());
                }
            });
            self.history_panel(ui);
            self.storage_panel(ui);
            self.online_panel(ui);
        });
    }

    fn history_panel(&mut self, ui: &mut egui::Ui) {
        let Some(works) = self.history.clone() else {
            return;
        };
        ui.separator();
        ui.heading("Histórico dos navegadores");
        ui.label("Escolha as obras: os capítulos antes do último visto contam como lidos; o último, como onde você parou.");
        for (i, w) in works.iter().enumerate() {
            let last = w
                .chapters
                .last()
                .map(|c| jobs::number_text(c.chapter))
                .unwrap_or_default();
            let known = if w.work_id.is_some() {
                "já na biblioteca"
            } else {
                "obra nova"
            };
            ui.checkbox(
                &mut self.history_pick[i],
                format!(
                    "{} — {} capítulos, último {last} ({known}; {})",
                    w.name,
                    w.chapters.len(),
                    w.sites.join(", ")
                ),
            );
        }
        ui.horizontal(|ui| {
            if ui.button("Importar as marcadas").clicked() {
                let chosen: Vec<_> = works
                    .iter()
                    .zip(&self.history_pick)
                    .filter(|(_, p)| **p)
                    .map(|(w, _)| w.clone())
                    .collect();
                match toon_core::history::import(&chosen) {
                    Ok(n) => self.notice = format!("{n} capítulos importados do histórico."),
                    Err(e) => self.notice = e.to_string(),
                }
                self.history = None;
                self.reload();
            }
            if ui.button("Fechar").clicked() {
                self.history = None;
            }
        });
    }

    fn storage_panel(&mut self, ui: &mut egui::Ui) {
        let Some(usage) = self.storage.clone() else {
            return;
        };
        use toon_core::storage::human;
        ui.separator();
        ui.heading("Espaço em disco");
        ui.label(format!("Capítulos da biblioteca: {}", human(usage.library)));
        ui.label(format!("Exemplos de treino: {}", human(usage.dataset)));
        for (label, area, size) in [
            (
                "Páginas para refazer capítulos (camadas)",
                "layers",
                usage.layers,
            ),
            ("Respostas guardadas das IAs", "aiCache", usage.ai_cache),
            ("Cache do navegador do app", "appCache", usage.app_cache),
        ] {
            ui.horizontal(|ui| {
                ui.label(format!("{label}: {}", human(size)));
                if ui.small_button("Limpar").clicked() {
                    match toon_core::storage::clear(area) {
                        Ok(u) => self.storage = Some(u),
                        Err(e) => self.notice = e.to_string(),
                    }
                }
            });
        }
    }

    fn online_panel(&mut self, ui: &mut egui::Ui) {
        ui.separator();
        ui.heading("Avisos e internet");
        let status = crate::cloud::STATUS.lock().clone();
        let text = if !status.configured {
            "Sincronização pela internet desligada (cloud.json sem projeto).".to_string()
        } else if status.connected {
            format!(
                "Sincronizando pelo Firebase · {} celulares no espaço · push {}",
                status.members,
                if status.push { "ligado" } else { "desligado" }
            )
        } else {
            format!(
                "Firebase configurado, sem conexão: {}",
                status.error.unwrap_or_default()
            )
        };
        ui.label(text);
        let topic = toon_core::updates::load().ntfy_topic;
        let mut ntfy = topic.is_some();
        if ui
            .checkbox(
                &mut ntfy,
                "Avisar no celular pelo ntfy.sh quando não houver push do Firebase",
            )
            .changed()
        {
            match crate::notify::set_ntfy(ntfy) {
                Ok(Some(t)) => {
                    self.notice = format!("Assine o tópico \"{t}\" no app ntfy do celular.")
                }
                Ok(None) => self.notice = "Avisos pelo ntfy desligados.".into(),
                Err(e) => self.notice = e.to_string(),
            }
        }
        if let Some(t) = topic {
            ui.label(RichText::new(format!("Tópico do ntfy: {t}")).weak());
        }
        if status.configured {
            ui.horizontal(|ui| {
                if ui.button("Colar chave da conta de serviço (push)").clicked() {
                    if let Some(file) = rfd::FileDialog::new().add_filter("JSON", &["json"]).pick_file() {
                        let result = std::fs::read_to_string(file).map_err(anyhow::Error::from).and_then(|t| crate::cloud::set_push_key(Some(&t)));
                        self.notice = match result {
                            Ok(()) => "Chave guardada: os capítulos novos chegam como notificação no celular.".into(),
                            Err(e) => e.to_string(),
                        };
                    }
                }
                if status.push && ui.button("Esquecer a chave").clicked() {
                    let _ = crate::cloud::set_push_key(None);
                }
            });
        }
    }
}

fn language_combo(ui: &mut egui::Ui, label: &str, value: &mut String, auto: bool) {
    ui.label(label);
    egui::ComboBox::from_id_salt(label)
        .selected_text(settings::language_label(value))
        .show_ui(ui, |ui| {
            if auto {
                ui.selectable_value(
                    value,
                    settings::AUTO_LANGUAGE.to_string(),
                    settings::language_label(settings::AUTO_LANGUAGE),
                );
            }
            for (v, l) in LANGUAGES {
                ui.selectable_value(value, v.to_string(), *l);
            }
        });
}
