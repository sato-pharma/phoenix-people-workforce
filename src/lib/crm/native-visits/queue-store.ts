/**
 * The phone's offline shelf for native visits (owner decision 20: an offline queue in the first
 * release). Same pattern as src/lib/marketing-requests/validation-draft-store.ts.
 *
 * A visit is written HERE FIRST and only then sent, so a rep with no signal who presses Save never
 * loses it: it waits on the phone and goes out when the connection returns. Each entry carries its
 * own submission id, so sending it twice saves it once.
 *
 * NOTHING HERE MAY THROW INTO THE FORM. Private windows, blocked storage and a full disk all degrade
 * to a form that still sends while online and simply cannot keep a visit through a reload.
 */

const DATABASE_NAME = "phoenix-native-visits";
const DATABASE_VERSION = 1;
const STORE_NAME = "queue";
const PENDING_KEY = "pending";
const REFUSED_KEY = "refused";

export type QueuedNativeVisit = {
  clientSubmissionId: string;
  /** What the rep sees in the waiting list, so he can tell one queued visit from another. */
  summary: string;
  payload: Record<string, unknown>;
  queuedAt: string;
};

export type RefusedNativeVisit = QueuedNativeVisit & { error: string };

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
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
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
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

function isQueued(value: unknown): value is QueuedNativeVisit {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.clientSubmissionId === "string" && typeof entry.payload === "object" && entry.payload !== null;
}

async function readList(key: string): Promise<unknown[]> {
  const value = await withStore<unknown>("readonly", (store) => store.get(key), null);
  return Array.isArray(value) ? value : [];
}

async function writeList(key: string, list: unknown[]): Promise<boolean> {
  let cloneable: unknown;
  try {
    cloneable = JSON.parse(JSON.stringify(list));
  } catch {
    return false;
  }
  // A successful put answers with its key; the fallback answers false.
  return withStore<unknown>("readwrite", (store) => store.put(cloneable, key), false).then((result) => Boolean(result));
}

export async function readPendingNativeVisits(): Promise<QueuedNativeVisit[]> {
  return (await readList(PENDING_KEY)).filter(isQueued);
}

export async function savePendingNativeVisits(list: QueuedNativeVisit[]): Promise<boolean> {
  return writeList(PENDING_KEY, list);
}

export async function readRefusedNativeVisits(): Promise<RefusedNativeVisit[]> {
  return (await readList(REFUSED_KEY)).filter(
    (entry): entry is RefusedNativeVisit => isQueued(entry) && typeof (entry as { error?: unknown }).error === "string",
  );
}

export async function saveRefusedNativeVisits(list: RefusedNativeVisit[]): Promise<boolean> {
  return writeList(REFUSED_KEY, list);
}
