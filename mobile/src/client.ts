import { createClient } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { createAvanaService } from "../../shared/service";
import { createSupabaseTransport } from "../../shared/supabaseTransport";
import { authStorage } from "./storage";

export const cloudUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() || "";
const publicKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || "";
export function configurationError(): string | null {
  if (!cloudUrl || !publicKey)
    return "Defina EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY no arquivo mobile/.env e reinicie o Expo.";
  try {
    const parsed = new URL(cloudUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return "Use o endereço HTTPS do projeto Supabase, sem credenciais ou parâmetros.";
    if (publicKey.startsWith("sb_secret_"))
      return "O aplicativo aceita somente a chave pública publishable/anon, nunca a chave secreta.";
    if (publicKey.startsWith("eyJ")) {
      const payload = JSON.parse(
        atob(publicKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      if (payload.role !== "anon")
        return "Use somente a chave pública anon do Supabase.";
    } else if (!publicKey.startsWith("sb_publishable_"))
      return "A chave pública Supabase não foi reconhecida.";
    return null;
  } catch {
    return "Confira a URL e a chave pública do Supabase.";
  }
}
export const client = configurationError()
  ? null
  : createClient(cloudUrl, publicKey, {
      auth: {
        storage: authStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
export function createService(userId: string) {
  if (!client) throw new Error("Supabase não configurado.");
  const scope = `${cloudUrl}|${userId}`;
  return {
    scope,
    service: createAvanaService({
      scope,
      transport: createSupabaseTransport(client, userId),
      storage: AsyncStorage,
      uuid: () => Crypto.randomUUID(),
      fingerprint: (value) =>
        Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
    }),
  };
}
export type Service = ReturnType<typeof createAvanaService>;
export function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Não foi possível concluir. Tente novamente.";
}
