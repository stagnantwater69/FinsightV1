import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { CHAT_SEND_MAX_BYTES, parsePendingChatSend, utf8Bytes, type ChatSendPersistence, type PendingChatSend } from "./chatSendIntent";

const PREFIX = "finsight.chat.pending.";
const queues = new Map<string, Promise<unknown>>();
const generations = new Map<string, number>();
const storage = {
  getItemAsync: (key: string): Promise<string | null> => Platform.OS === "web" ? Promise.resolve(sessionStorage.getItem(key)) : SecureStore.getItemAsync(key),
  setItemAsync: (key: string, value: string): Promise<void> => Platform.OS === "web" ? Promise.resolve(sessionStorage.setItem(key, value)) : SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key: string): Promise<void> => Platform.OS === "web" ? Promise.resolve(sessionStorage.removeItem(key)) : SecureStore.deleteItemAsync(key),
};

function ownerKey(ownerId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(ownerId)) throw new Error("This account cannot save question recovery details.");
  return `${PREFIX}${ownerId}`;
}

function serial<T>(ownerId: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(ownerId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  queues.set(ownerId, current);
  void current.finally(() => { if (queues.get(ownerId) === current) queues.delete(ownerId); }).catch(() => undefined);
  return current;
}

async function index(ownerId: string): Promise<number[]> {
  const raw = await storage.getItemAsync(`${ownerKey(ownerId)}.index`);
  if (!raw) return [];
  const ids: unknown = JSON.parse(raw);
  if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Saved question recovery could not be read.");
  return ids as number[];
}

async function read(ownerId: string, businessProfileId: number): Promise<PendingChatSend | null> {
  const key = `${ownerKey(ownerId)}.${businessProfileId}`;
  const head = await storage.getItemAsync(key);
  if (!head) return null;
  const header = JSON.parse(head) as { parts?: unknown };
  if (!Number.isSafeInteger(header.parts) || (header.parts as number) < 1 || (header.parts as number) > 32) throw new Error("Saved question recovery is incomplete.");
  let raw = "";
  for (let i = 0; i < (header.parts as number); i++) {
    const part = await storage.getItemAsync(`${key}.${i}`);
    if (part === null) throw new Error("Saved question recovery is incomplete.");
    raw += part;
    if (raw.length > CHAT_SEND_MAX_BYTES) throw new Error("Saved question recovery is too large.");
  }
  return parsePendingChatSend(JSON.parse(raw), ownerId, businessProfileId);
}

async function removeSlot(ownerId: string, businessProfileId: number): Promise<void> {
  const key = `${ownerKey(ownerId)}.${businessProfileId}`;
  // Partial writes can leave indexed chunks without a readable header.
  for (let i = 0; i < 32; i++) await storage.deleteItemAsync(`${key}.${i}`);
  await storage.deleteItemAsync(key);
}

export const chatSendPersistence: ChatSendPersistence = {
  read: (ownerId, businessProfileId) => serial(ownerId, () => read(ownerId, businessProfileId)),
  store: (intent) => {
    if (!intent.ownerId) return Promise.reject(new Error("Sign in before sending a question."));
    const ownerId = intent.ownerId;
    const generation = generations.get(ownerId) ?? 0;
    return serial(ownerId, async () => {
      if ((generations.get(ownerId) ?? 0) !== generation) throw new Error("The account changed. Nothing was sent.");
      const verified = parsePendingChatSend(intent, ownerId, intent.body.businessProfileId);
      const previous = await read(ownerId, intent.body.businessProfileId);
      if (previous && previous.body.idempotencyKey !== verified.body.idempotencyKey) throw new Error("A previous question still needs checking before sending another.");
      const key = `${ownerKey(ownerId)}.${intent.body.businessProfileId}`;
      const chunks: string[] = [];
      let chunk = "";
      let bytes = 0;
      for (const character of JSON.stringify(verified)) {
        const next = utf8Bytes(character);
        if (bytes + next > 1500) { chunks.push(chunk); chunk = ""; bytes = 0; }
        chunk += character; bytes += next;
      }
      if (chunk) chunks.push(chunk);
      const ids = await index(ownerId);
      if (!ids.includes(intent.body.businessProfileId)) ids.push(intent.body.businessProfileId);
      if (ids.length > 100) throw new Error("Too many unfinished questions are stored on this device. Check an earlier question first.");
      await storage.setItemAsync(`${ownerKey(ownerId)}.index`, JSON.stringify(ids));
      for (let i = 0; i < chunks.length; i++) await storage.setItemAsync(`${key}.${i}`, chunks[i]!);
      await storage.setItemAsync(key, JSON.stringify({ parts: chunks.length }));
      const restored = await read(ownerId, intent.body.businessProfileId);
      if (!restored || JSON.stringify(restored) !== JSON.stringify(verified)) throw new Error("Question recovery could not be saved. Nothing was sent.");
      if ((generations.get(ownerId) ?? 0) !== generation) throw new Error("The account changed. Nothing was sent.");
    });
  },
  remove: (intent) => {
    if (!intent.ownerId) return Promise.resolve();
    const ownerId = intent.ownerId;
    return serial(ownerId, async () => {
      const existing = await read(ownerId, intent.body.businessProfileId);
      if (existing?.body.idempotencyKey !== intent.body.idempotencyKey) return;
      await removeSlot(ownerId, intent.body.businessProfileId);
      const ids = (await index(ownerId)).filter((id) => id !== intent.body.businessProfileId);
      await storage.setItemAsync(`${ownerKey(ownerId)}.index`, JSON.stringify(ids));
    });
  },
};

export function clearChatSendRecovery(ownerId: string | number): Promise<void> {
  const owner = String(ownerId);
  generations.set(owner, (generations.get(owner) ?? 0) + 1);
  return serial(owner, async () => {
    for (const businessProfileId of await index(owner)) await removeSlot(owner, businessProfileId);
    await storage.deleteItemAsync(`${ownerKey(owner)}.index`);
  });
}
