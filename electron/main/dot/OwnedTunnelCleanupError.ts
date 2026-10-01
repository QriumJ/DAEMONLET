import type {RunningTunnel} from './BelleConnectionManager'
/** Keeps unconfirmed app-owned cleanup reachable without exposing a child/PID to the renderer. */
export class OwnedTunnelCleanupError extends Error {
 constructor(readonly running:RunningTunnel){super('CONNECTION_FAILED')}
}
