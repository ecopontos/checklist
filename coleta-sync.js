import { syncPendingColetas } from './google-sync.js';

export function startColetaSync(db, options = {}) {
    const {
        autoStart = true,
        intervalMs = 5 * 60 * 1000,
        onState = () => {},
        onResult = () => {}
    } = options;
    let inFlight = null;
    let stopped = false;

    const notify = (callback, value) => {
        try { callback(value); } catch (error) { console.error('Falha no observador do sync de coletas', error); }
    };
    const refresh = () => {
        if (stopped) return Promise.resolve({ ok: false, error: 'Sincronização encerrada', pending: db.getUnsyncedColetas().length });
        if (inFlight) return inFlight;
        notify(onState, 'syncing');
        let task;
        try { task = syncPendingColetas(db); }
        catch (error) { task = Promise.reject(error); }
        inFlight = Promise.resolve(task)
            .catch(error => ({ ok: false, error: error.message, pending: db.getUnsyncedColetas().length }))
            .then(result => {
                const normalized = {
                    ...result,
                    pending: Number.isInteger(result?.pending) ? result.pending : db.getUnsyncedColetas().length
                };
                notify(onResult, normalized);
                notify(onState, normalized.ok && normalized.pending === 0 ? 'idle' : 'pending');
                return normalized;
            })
            .finally(() => { inFlight = null; });
        return inFlight;
    };
    const handleOnline = () => { refresh(); };
    const handleVisibility = () => {
        if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    const interval = intervalMs > 0 ? setInterval(() => {
        if (document.visibilityState === 'visible') refresh();
    }, intervalMs) : null;
    if (autoStart) Promise.resolve().then(refresh);

    return {
        refresh,
        stop() {
            stopped = true;
            window.removeEventListener('online', handleOnline);
            document.removeEventListener('visibilitychange', handleVisibility);
            if (interval !== null) clearInterval(interval);
        }
    };
}
