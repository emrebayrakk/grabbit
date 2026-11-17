// Sürüm derlemesinde konsol penceresi açılmasın
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod commands;
mod notify;

fn main() {
    app::run();
}
