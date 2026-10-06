import type { administration } from '@aegis/contracts';

export interface LeaseApi {
  heartbeat(grantId: string, userActive: boolean): Promise<administration.LeaseView>;
  release(grantId: string): Promise<void>;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type LeaseLossReason = 'expired' | 'revoked' | 'network';

/**
 * Keeps a privileged lease alive while the administration console is open. Heartbeats report
 * whether the operator interacted since the last beat, so an unattended tab reaches the server's
 * idle timeout. Any heartbeat rejection is treated as loss: the console must close privileged
 * views immediately (the server already refuses further commands).
 */
export class LeaseKeeper {
  private handle: unknown = null;
  private interacted = false;
  private lease: administration.LeaseView;
  private consecutiveNetworkFailures = 0;

  constructor(
    initial: administration.LeaseView,
    private readonly api: LeaseApi,
    private readonly timers: Timers,
    private readonly onLost: (reason: LeaseLossReason) => void,
    private readonly onRenewed: (lease: administration.LeaseView) => void = () => undefined,
  ) {
    this.lease = initial;
  }

  get current(): administration.LeaseView {
    return this.lease;
  }

  start(): void {
    if (this.handle !== null) return;
    const intervalMs = Math.max(5, this.lease.heartbeatIntervalSeconds) * 1000;
    this.handle = this.timers.setInterval(() => void this.beat(), intervalMs);
  }

  /** Call on operator input (key press, tap, navigation). */
  noteInteraction(): void {
    this.interacted = true;
  }

  async beat(): Promise<void> {
    const userActive = this.interacted;
    this.interacted = false;
    try {
      this.lease = await this.api.heartbeat(this.lease.grantId, userActive);
      this.consecutiveNetworkFailures = 0;
      this.onRenewed(this.lease);
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status: unknown }).status)
          : 0;
      if (status === 409 || status === 403 || status === 401) {
        this.stop();
        this.onLost(status === 409 ? 'expired' : 'revoked');
        return;
      }
      // Network trouble: the server's lease TTL decides. Report loss once a beat would have failed
      // long enough that the server has certainly expired the lease.
      this.consecutiveNetworkFailures += 1;
      if (Date.parse(this.lease.expiresAt) <= Date.now()) {
        this.stop();
        this.onLost('network');
      }
    }
  }

  async release(): Promise<void> {
    this.stop();
    await this.api.release(this.lease.grantId);
  }

  stop(): void {
    if (this.handle !== null) this.timers.clearInterval(this.handle);
    this.handle = null;
  }

  get networkFailures(): number {
    return this.consecutiveNetworkFailures;
  }
}
