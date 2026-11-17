//! O trabalho em cima das páginas: achar o letreiro, cortar a página em faixas para o modelo, apagar
//! o texto original, escrever a tradução e montar os PDFs.

pub mod detect;
pub mod fonts;
pub mod glyphs;
pub mod marks;
pub mod overlay;
pub mod page;
pub mod pdf;
pub mod slicing;
pub mod chapter;
