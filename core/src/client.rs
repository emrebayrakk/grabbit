//! Tarayıcılar (Vivaldi gibi) kendini User-Agent'ta Chrome diye tanıtabildiği için köprüye bağlanan
//! TCP bağlantısının sahibi olan programa Windows'un TCP tablosundan bakılır (alt süreç açmadan).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const EXE_NAMES: [(&str, &str); 5] = [
    ("chrome.exe", "Google Chrome"),
    ("msedge.exe", "Microsoft Edge"),
    ("brave.exe", "Brave"),
    ("opera.exe", "Opera"),
    ("vivaldi.exe", "Vivaldi"),
];

#[derive(Debug, Clone)]
pub struct Client {
    pub exe: String,
    pub browser: Option<String>,
}

static CACHE: LazyLock<Mutex<HashMap<(u16, u16), (Instant, Option<Client>)>>> = LazyLock::new(Default::default);

/// İstek gönderen programın adı. `remote_port`: istemcinin portu, `local_port`: köprünün portu.
pub fn identify(remote_port: u16, local_port: u16) -> Option<Client> {
    let key = (remote_port, local_port);
    if let Some((at, v)) = CACHE.lock().unwrap().get(&key) {
        if at.elapsed() < Duration::from_secs(60) {
            return v.clone();
        }
    }
    let value = owner_pid(remote_port, local_port).and_then(image_name).map(|exe| {
        let browser = EXE_NAMES.iter().find(|(e, _)| *e == exe).map(|(_, n)| n.to_string());
        Client { exe, browser }
    });
    let mut c = CACHE.lock().unwrap();
    if c.len() > 200 {
        c.clear();
    }
    c.insert(key, (Instant::now(), value.clone()));
    value
}

#[cfg(windows)]
fn owner_pid(remote_port: u16, local_port: u16) -> Option<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL};
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    let mut size = 0u32;
    unsafe {
        GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0);
    }
    for _ in 0..3 {
        let mut buf = vec![0u8; size as usize + 4096];
        let mut len = buf.len() as u32;
        let rc = unsafe { GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut len, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_ALL, 0) };
        if rc == 122 {
            // ERROR_INSUFFICIENT_BUFFER: tablo bu arada büyüdü
            size = len;
            continue;
        }
        if rc != 0 {
            return None;
        }
        let table = unsafe { &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
        let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        let port = |p: u32| u16::from_be((p & 0xffff) as u16);
        // İstemci tarafındaki satır: kendi portu = remote_port, karşı port = köprü
        return rows.iter().find(|r| port(r.dwLocalPort) == remote_port && port(r.dwRemotePort) == local_port).map(|r| r.dwOwningPid);
    }
    None
}

#[cfg(windows)]
fn image_name(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().map(str::to_lowercase)
    }
}

#[cfg(not(windows))]
fn owner_pid(_: u16, _: u16) -> Option<u32> {
    None
}

#[cfg(not(windows))]
fn image_name(_: u32) -> Option<String> {
    None
}
