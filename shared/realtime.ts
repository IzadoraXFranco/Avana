import type { SupabaseClient } from "@supabase/supabase-js";

export type RealtimeState = "connecting" | "connected" | "reconnecting";
export function subscribeWorkspace(
  client: SupabaseClient,
  workspaceId: string,
  onChange: () => void,
  onState: (state: RealtimeState) => void = () => undefined,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = undefined; if (!stopped) onChange(); }, 80);
  };
  onState("connecting");
  const channel = client.channel(`avana-workspace:${workspaceId}:${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "avana_workspaces", filter: `id=eq.${workspaceId}` }, refresh)
    .subscribe(status => {
      if (stopped) return;
      onState(status === "SUBSCRIBED" ? "connected" : "reconnecting");
      if (status === "SUBSCRIBED") refresh(); // recupera eventos perdidos na reconexão
    });
  // Protege contra publicação desativada, suspensão de aba e eventos perdidos.
  const poll = setInterval(refresh, 30_000);
  return () => {
    stopped = true;
    clearInterval(poll);
    if (timer) clearTimeout(timer);
    void client.removeChannel(channel);
  };
}
