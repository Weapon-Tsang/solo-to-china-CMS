import { MediaJournal } from './media-journal.js';

// Reproducible derivatives use a separate database. Cache eviction must never
// touch the pending-original journal or its capture manifests.
export class DerivativeCache extends MediaJournal {
  constructor(options = {}) { super({name:'stc-derived-media-v1',maxBytes:64*1024*1024,...options}); }
  key(originalHash, transform) {
    return `${originalHash}:${JSON.stringify(Object.fromEntries(Object.keys(transform).sort().map(key=>[key,transform[key]])))}`;
  }
  async save(key, value) {
    if (value.bytes.byteLength > this.maxBytes) return false;
    for (let attempt=0;attempt<16;attempt++) {
      try { await this.put(key,value); return true; }
      catch(error) {
        if (error.code !== 'MEDIA_JOURNAL_QUOTA' && error.name !== 'QuotaExceededError') throw error;
        const db=await this.database();
        const victim=await new Promise((resolve,reject)=>{
          const cursor=db.transaction('usage').objectStore('usage').openKeyCursor();
          cursor.onerror=()=>reject(cursor.error);
          cursor.onsuccess=()=>{const current=cursor.result;if(!current)return resolve(null);if(current.key==='__total__'||current.key===key)current.continue();else resolve(current.key);};
        });
        if (!victim) return false;
        await this.remove(victim);
      }
    }
    return false;
  }
}
export const derivativeCache = new DerivativeCache();
