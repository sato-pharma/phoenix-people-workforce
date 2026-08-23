/**
 * Browser-side persistence for the field validation form. Rules live in `validation-draft.ts`;
 * this file is only the shelf they sit on.
 *
 * INDEXEDDB, NOT LOCALSTORAGE. A single evidence photo may be up to 2 MB
 * (`MARKETING_EVIDENCE_MAX_UPLOAD_BYTES`), it is held as a base64 data URL — which inflates it by
 * about a third — and one submission carries a photo per customer plus a photo per pharmacy. That
 * clears the ~5 MB localStorage budget on an ordinary three-customer visit, and localStorage
 * signals the overflow by THROWING mid-write, which would take the form down with it. IndexedDB is
 * measured in tens of megabytes and stores the string without a second copy.
 *
 * NOTHING HERE MAY THROW INTO THE FORM. Private windows, "block all cookies", a locked profile and
 * a full disk all make storage unavailable, and every one of those must degrade to exactly the
 * behaviour we have today — a form that works and simply does not recover after a refresh. Losing
 * the safety net is a bad afternoon; a capture screen that will not open is a rep who cannot work
 * at all. So every export resolves rather than rejects, and a failure is reported as a value.
 */

const DATABASE_NAME = "phoenix-marketing-validation";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";

/** One in-flight form. */
const DRAFT_KEY = "validation-draft";
/** Submissions the rep believes are saved, waiting for connectivity. */
const QUEUE_KEY = "validation-queue";

function isAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!isAvailable()) return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Another tab holding an old version open. Give up rather than hang the mount.
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  const db = await openDatabase();
  if (!db) return fallback;

  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      db.close();
      resolve(value);
    };

    try {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = work(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => finish((request.result ?? fallback) as T);
      request.onerror = () => finish(fallback);
      transaction.onabort = () => finish(fallback);
      transaction.onerror = () => finish(fallback);
    } catch {
      finish(fallback);
    }
  });
}

/**
 * Structured-clone rejects anything holding a function, a DOM node or a cycle. Everything we store
 * is plain JSON today, but the form's state shape is edited often, so a round-trip through JSON
 * guarantees a cloneable value instead of failing the write at save time — which is the one moment
 * a silent failure would cost the rep the work this module exists to protect.
 */
function toCloneable(value: unknown): unknown | null {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

async function writeKey(key: string, value: unknown): Promise<boolean> {
  const cloneable = toCloneable(value);
  if (cloneable === null) return false;
  return withStore("readwrite", (store) => store.put(cloneable, key), false).then(() => true);
}

async function readKey(key: string): Promise<unknown> {
  return withStore<unknown>("readonly", (store) => store.get(key), null);
}

async function deleteKey(key: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(key), undefined);
}

export async function saveValidationDraft(draft: unknown): Promise<boolean> {
  return writeKey(DRAFT_KEY, draft);
}

export async function readValidationDraft(): Promise<unknown> {
  return readKey(DRAFT_KEY);
}

export async function clearValidationDraft(): Promise<void> {
  await deleteKey(DRAFT_KEY);
}

/**
 * The offline queue was pure React state until now, which meant a rep who pressed Save with no
 * signal was shown "Saved offline. Will sync automatically" and then lost the submission entirely
 * on the next reload — with no error and no row anywhere to notice it by. That is a worse failure
 * than the one this module was written for, because the rep has already been told it is safe.
 */
export async function saveValidationQueue(queue: unknown): Promise<boolean> {
  return writeKey(QUEUE_KEY, queue);
}

export async function readValidationQueue(): Promise<unknown> {
  return readKey(QUEUE_KEY);
}

export async function clearValidationQueue(): Promise<void> {
  await deleteKey(QUEUE_KEY);
}
