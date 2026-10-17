import type { RetryStorage } from "../shared/service";

// Each tab owns its retry journal. A cloned tab inherits sessionStorage, so an
// exclusive Web Lock distinguishes that clone from a reload of the original.
let identity: Promise<string> | undefined;
let releaseLease: (() => void) | undefined;
async function acquireIdentity(): Promise<string> {
  if (!navigator.locks) throw new Error("O navegador precisa oferecer Web Locks.");
  let candidate = sessionStorage.getItem("avana:retry-client-id") || crypto.randomUUID();
  for (;;) {
    const owned = await new Promise<boolean>((resolve, reject) => {
      void navigator.locks.request(`avana:retry-client-lease:${candidate}`, { ifAvailable: true }, async lock => {
        if (!lock) { resolve(false); return; }
        await new Promise<void>(release => { releaseLease = release; resolve(true); });
      }).catch(reject);
    });
    if (owned) {
      try { sessionStorage.setItem("avana:retry-client-id", candidate); }
      catch (error) { releaseLease?.(); releaseLease = undefined; throw error; }
      return candidate;
    }
    candidate = crypto.randomUUID();
  }
}
const clientId = () => identity ||= acquireIdentity().catch(error => { identity = undefined; throw error; });
window.addEventListener("pagehide", () => {
  releaseLease?.(); releaseLease = undefined; identity = undefined;
});
export const browserRetryStorage: RetryStorage = {
  getItem: async key => localStorage.getItem(`${key}:client:${await clientId()}`),
  setItem: async (key, value) => localStorage.setItem(`${key}:client:${await clientId()}`, value),
  withLock: async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const id = await clientId();
    return navigator.locks.request(`${key}:client:${id}`, action);
  },
};
