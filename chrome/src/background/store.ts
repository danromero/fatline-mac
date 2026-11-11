/**
 * IndexedDB at the extension's own origin. Nothing secret goes in chrome.storage, because content
 * scripts can read chrome.storage.local by default and they run beside x.com.
 */
let opened: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("fatline", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opened = null;
      reject(request.error);
    };
  });
  return opened;
}

export async function read<T>(key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction("kv").objectStore("kv").get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function write(key: string, value: unknown): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("kv", "readwrite");
    transaction.objectStore("kv").put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function remove(key: string): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("kv", "readwrite");
    transaction.objectStore("kv").delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
