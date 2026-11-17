//! Grabbit çekirdeği: indirme motoru, video siteleri, tarayıcı köprüsü. Arayüzden bağımsızdır.

// AppError dil anahtarı ve parametre taşır; hatalar sık değil, kutulamaya gerek yok
#![allow(clippy::result_large_err, clippy::type_complexity)]

pub mod bridge;
pub mod browsers;
pub mod client;
pub mod download;
pub mod fullsize;
pub mod hls;
pub mod http;
pub mod i18n;
pub mod item;
pub mod limiter;
pub mod manager;
pub mod media;
pub mod settings;
pub mod tools;
pub mod util;

pub use manager::{Event, Manager, NewEntry};
