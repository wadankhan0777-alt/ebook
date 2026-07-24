/* ============================================================
 * store.js — offline book storage in IndexedDB. Every book you
 * open (or explicitly download) is kept on-device: full cleaned
 * text plus a cached page layout, so books open instantly and
 * keep working with no internet connection.
 * ============================================================ */

const BookStore = (() => {
  const DB_NAME = "folio-books";
  const STORE = "books";
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function get(id) {
    const d = await db();
    return req(d.transaction(STORE).objectStore(STORE).get(id));
  }

  async function has(id) {
    return !!(await get(id).catch(() => null));
  }

  /** Save/refresh a book. Preserves an existing cached pagination. */
  async function save(meta, text) {
    const d = await db();
    const existing = await req(d.transaction(STORE).objectStore(STORE).get(meta.id)).catch(() => null);
    const rec = { ...(existing || {}), ...meta, text, ts: Date.now() };
    return req(d.transaction(STORE, "readwrite").objectStore(STORE).put(rec));
  }

  async function savePagination(id, pag) {
    const d = await db();
    const rec = await req(d.transaction(STORE).objectStore(STORE).get(id)).catch(() => null);
    if (!rec) return;
    rec.pag = pag;
    return req(d.transaction(STORE, "readwrite").objectStore(STORE).put(rec));
  }

  async function remove(id) {
    const d = await db();
    return req(d.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  }

  /** List stored books (metadata only — text stays on disk). */
  async function list() {
    const d = await db();
    const all = await req(d.transaction(STORE).objectStore(STORE).getAll());
    return (all || [])
      .map(({ text, pag, ...meta }) => ({ ...meta, size: text ? text.length : 0 }))
      .sort((a, b) => b.ts - a.ts);
  }

  function metaFrom(book) {
    return {
      id: book.id,
      title: book.title,
      author: FolioAPI.authorName(book),
      cover: FolioAPI.coverUrl(book),
      subjects: (book.subjects || []).slice(0, 4),
      local: !!book.local,
    };
  }

  /** Rebuild a catalog-shaped record from stored metadata. */
  function recordFrom(meta) {
    return {
      id: meta.id,
      title: meta.title,
      authors: [{ name: meta.author || "Unknown author" }],
      subjects: meta.subjects || [],
      formats: meta.cover ? { "image/jpeg": meta.cover } : {},
      download_count: 0,
      local: !!meta.local,
    };
  }

  return { get, has, save, savePagination, remove, list, metaFrom, recordFrom };
})();
