import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./service.ts";
import type { Transport } from "./service.ts";

export function createSupabaseTransport(client: SupabaseClient, expectedUserId: string): Transport {
  return async <T>({ method, path, body, requestId }: Parameters<Transport>[0]): Promise<T> => {
    let response;
    try {
      response = await client.rpc("avana_api", {
        p_method: method, p_path: path, p_body: body, p_request_id: requestId ?? null,
        p_expected_user_id: expectedUserId,
      });
    } catch {
      throw new ApiError("Sem conexão com o Avana. Seu conteúdo foi preservado; tente novamente.", 0, "NETWORK_ERROR");
    }
    if (response.error) {
      let domain: { error?: string; code?: string; status?: number } = {};
      try { domain = JSON.parse(response.error.message); } catch { /* erro de transporte/PostgREST */ }
      if (domain.error) throw new ApiError(domain.error, domain.status || 400, domain.code);
      const status = response.status || 0;
      const message = status === 401 ? "Entre novamente para acessar o Avana."
        : status === 403 ? "Sua conta não tem permissão para esta ação."
        : response.error.code === "PGRST202" ? "A estrutura do Avana ainda não foi aplicada neste projeto Supabase."
        : "Não foi possível acessar a nuvem. Seu conteúdo foi preservado; tente novamente.";
      throw new ApiError(message, status, response.error.code);
    }
    return response.data as T;
  };
}
