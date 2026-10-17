import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { withProcessLock } from "../../shared/service";

// Tokens stay in Android's encrypted storage. A manifest written last makes a
// multi-chunk refresh atomic; failed refreshes preserve the previous session.
type Manifest = { revision: string; count: number };
async function keyFor(key: string) {
  return `avana.auth.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key)}`;
}
function chunks(value: string) {
  const result: string[] = [];
  let current = "",
    bytes = 0;
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    const width = cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    if (bytes + width > 1800) {
      result.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += width;
  }
  result.push(current);
  return result;
}
async function manifest(key: string): Promise<Manifest | null> {
  const raw = await SecureStore.getItemAsync(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Manifest;
  if (
    !parsed.revision ||
    !Number.isInteger(parsed.count) ||
    parsed.count < 1 ||
    parsed.count > 1000
  )
    throw new Error("A sessão armazenada não pôde ser lida.");
  return parsed;
}
async function removeChunks(key: string, previous: Manifest | null) {
  if (previous)
    await Promise.all(
      Array.from({ length: previous.count }, (_, index) =>
        SecureStore.deleteItemAsync(
          `${key}.${previous.revision}.${index}`,
        ).catch(() => undefined),
      ),
    );
}
export const authStorage = {
  async getItem(original: string) {
    const key = await keyFor(original);
    return withProcessLock(key, async () => {
      const m = await manifest(key);
      if (!m) return null;
      const values = await Promise.all(
        Array.from({ length: m.count }, (_, index) =>
          SecureStore.getItemAsync(`${key}.${m.revision}.${index}`),
        ),
      );
      if (values.some((value) => value === null))
        throw new Error(
          "A sessão armazenada está incompleta. Entre novamente.",
        );
      return values.join("");
    });
  },
  async setItem(original: string, value: string) {
    const key = await keyFor(original);
    return withProcessLock(key, async () => {
      const previous = await manifest(key);
      const values = chunks(value);
      const next = { revision: Crypto.randomUUID(), count: values.length };
      try {
        for (let index = 0; index < values.length; index++)
          await SecureStore.setItemAsync(
            `${key}.${next.revision}.${index}`,
            values[index],
            { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
          );
        await SecureStore.setItemAsync(key, JSON.stringify(next), {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
      } catch (error) {
        await removeChunks(key, next);
        throw error;
      }
      await removeChunks(key, previous);
    });
  },
  async removeItem(original: string) {
    const key = await keyFor(original);
    return withProcessLock(key, async () => {
      const previous = await manifest(key);
      await SecureStore.deleteItemAsync(key);
      await removeChunks(key, previous);
    });
  },
};

export const draftStorage = {
  get: (key: string) => withProcessLock(key, () => AsyncStorage.getItem(key)),
  set: (key: string, value: string) =>
    withProcessLock(key, () => AsyncStorage.setItem(key, value)),
  remove: (key: string) =>
    withProcessLock(key, () => AsyncStorage.removeItem(key)),
};
