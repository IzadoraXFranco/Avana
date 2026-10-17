// Ajusta consultas de "hoje" ao relógio do servidor. Datas de prazo sem horário
// continuam sendo strings de calendário; não passam por esta conversão.
export function serverClockOffset(serverTime: string, sentAt: number, receivedAt: number): number | null {
  const server = Date.parse(serverTime);
  if (!Number.isFinite(server) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt) || receivedAt < sentAt) return null;
  return server - Math.round((sentAt + receivedAt) / 2);
}
