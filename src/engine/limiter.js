'use strict';

const { sleep } = require('./utils');

/**
 * Jeton kovası tabanlı hız sınırlayıcı. Aynı örneği paylaşan tüm bağlantılar
 * toplamda `rate` bayt/sn'yi geçmez. rate = 0 → sınırsız.
 */
class RateLimiter {
  constructor(bytesPerSecond = 0) {
    this.setRate(bytesPerSecond);
  }

  setRate(bytesPerSecond) {
    this.rate = Math.max(0, Math.floor(Number(bytesPerSecond) || 0));
    // Kısa bir patlama payı (200 ms) bırak; büyük kova sınırı ilk saniyelerde aşar
    this.capacity = this.rate / 5;
    this.tokens = 0;
    this.last = Date.now();
  }

  /**
   * Beklemek gerekiyorsa bir Promise, gerekmiyorsa null döner. Sıcak döngüde her parça için
   * gereksiz `await` (Promise + mikro görev) oluşmasın diye bilerek async değildir.
   */
  consume(n, signal) {
    if (!this.rate) return null;
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= n;
    return this.tokens < 0 ? sleep((-this.tokens / this.rate) * 1000, signal) : null;
  }
}

module.exports = { RateLimiter };
