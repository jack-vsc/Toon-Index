//! Trabalho assíncrono pedido pela janela: roda no runtime e a janela olha o resultado a cada quadro.

use std::sync::Arc;

use parking_lot::Mutex;

/// Um resultado que chega depois. `None` enquanto roda.
pub struct Pending<T>(Arc<Mutex<Option<T>>>);

impl<T> Clone for Pending<T> {
    fn clone(&self) -> Self {
        Pending(self.0.clone())
    }
}

impl<T: Send + 'static> Pending<T> {
    pub fn spawn<F>(runtime: &tokio::runtime::Runtime, ctx: &eframe::egui::Context, work: F) -> Self
    where
        F: Future<Output = T> + Send + 'static,
    {
        let slot = Arc::new(Mutex::new(None));
        let out = slot.clone();
        let ctx = ctx.clone();
        runtime.spawn(async move {
            let value = work.await;
            *out.lock() = Some(value);
            ctx.request_repaint();
        });
        Pending(slot)
    }

    /// Tira o resultado, quando já chegou.
    pub fn take(&self) -> Option<T> {
        self.0.lock().take()
    }
}
