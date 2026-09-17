// Pending originals use IndexedDB structured binary values, never base64 in
// chrome.storage.local. No automatic eviction of unfinished capture attempts.
export class MediaJournal {
  constructor({ name = 'stc-capture-journal-v1', maxBytes = 256 * 1024 * 1024, factory = globalThis.indexedDB } = {}) {
    this.name = name; this.maxBytes = maxBytes; this.factory = factory;
  }
  async database() {
    if (!this.factory) throw Object.assign(new Error('浏览器不支持可靠的媒体暂存。'), { code: 'MEDIA_JOURNAL_UNAVAILABLE', retryable: false });
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('records'); request.result.createObjectStore('usage'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return this.opening;
  }
  async get(key) {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const request = db.transaction('records').objectStore('records').get(key);
      request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
    });
  }
  async put(key, value) {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['records','usage'], 'readwrite');
      const records = transaction.objectStore('records'), usage = transaction.objectStore('usage');
      let customError;
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(customError || transaction.error);
      const oldSize = usage.get(key), total = usage.get('__total__');
      total.onsuccess = () => {
        const size = (value?.bytes?.byteLength || 0) + (value?.capture ? new TextEncoder().encode(JSON.stringify(value.capture)).byteLength : 0);
        const next = Number(total.result || 0) - Number(oldSize.result || 0) + size;
        if (next > this.maxBytes) {
          customError = Object.assign(new Error('媒体暂存预算已满；保留现有数据，等待完成后继续。'), { code: 'MEDIA_JOURNAL_QUOTA', retryable: true });
          transaction.abort(); return;
        }
        if (value == null) { records.delete(key); usage.delete(key); }
        else { records.put(value, key); usage.put(size, key); }
        usage.put(next, '__total__');
      };
    });
  }
  async remove(key) { await this.put(key, null); }
}
export const mediaJournal = new MediaJournal();
