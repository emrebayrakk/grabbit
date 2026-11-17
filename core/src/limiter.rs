//! Jeton kovası tabanlı hız sınırlayıcı. Aynı örneği paylaşan tüm bağlantılar toplamda
//! `rate` bayt/sn'yi geçmez. rate = 0 → sınırsız.

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    state: Mutex<State>,
}

struct State {
    rate: f64,
    capacity: f64,
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    pub fn new(bytes_per_second: u64) -> Self {
        let l = Self { state: Mutex::new(State { rate: 0.0, capacity: 0.0, tokens: 0.0, last: Instant::now() }) };
        l.set_rate(bytes_per_second);
        l
    }

    pub fn set_rate(&self, bytes_per_second: u64) {
        let mut s = self.state.lock().unwrap();
        s.rate = bytes_per_second as f64;
        // Kısa bir patlama payı (200 ms): büyük kova ilk saniyelerde sınırı aşar
        s.capacity = s.rate / 5.0;
        s.tokens = 0.0;
        s.last = Instant::now();
    }

    pub fn is_limited(&self) -> bool {
        self.state.lock().unwrap().rate > 0.0
    }

    /// `n` baytı harcar; beklemek gerekiyorsa ne kadar bekleneceğini döner.
    pub fn consume(&self, n: usize) -> Option<Duration> {
        let mut s = self.state.lock().unwrap();
        if s.rate <= 0.0 {
            return None;
        }
        let now = Instant::now();
        s.tokens = (s.tokens + now.duration_since(s.last).as_secs_f64() * s.rate).min(s.capacity);
        s.last = now;
        s.tokens -= n as f64;
        (s.tokens < 0.0).then(|| Duration::from_secs_f64(-s.tokens / s.rate))
    }
}
