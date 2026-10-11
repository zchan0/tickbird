import { randomBytes } from 'node:crypto';
import type { SessionData } from '../../core/src/model';
import type { ObservationHealth } from '../../core/src/live-session';
import { projectSidecar, type SidecarProjection, type TurnRenderCache } from './render';
import type { LiveExtras } from './chapter-view';

/** Only rendered, escaped public content crosses this bridge, never raw source objects. */
export class LiveView {
  readonly streamId = randomBytes(18).toString('hex');
  private version = 0;
  private projection: SidecarProjection;
  private readonly cache: TurnRenderCache = new Map();
  constructor(private readonly projectName: string, session: SessionData, private readonly locale?: string, live?: LiveExtras) {
    this.projection = projectSidecar({ projectName, session, locale, live }, this.cache);
  }
  get current() { return this.projection; }
  /** `live` is what the integration adds to the newest turn; it changes without a new record. */
  update(session: SessionData, health: ObservationHealth, reset = false, live?: LiveExtras) {
    const next = projectSidecar({ projectName: this.projectName, session, locale: this.locale, live }, this.cache);
    const before = new Map(this.projection.turns.map(turn => [turn.key, turn.html]));
    const previous = this.projection;
    const baseVersion = this.version++;
    this.projection = next;
    return { type: 'observation', streamId: this.streamId, sessionId: next.sessionKey, baseVersion, version: this.version, reset,
      health: { ...health }, name: next.name, identity: next.identity,
      order: next.turns.map(turn => turn.key),
      turns: next.turns.filter(turn => reset || before.get(turn.key) !== turn.html),
      ...(reset || previous.lens !== next.lens ? { lens: next.lens } : {}),
      ...(reset || previous.warnings !== next.warnings ? { warnings: next.warnings } : {}),
      ...(reset || previous.empty !== next.empty ? { empty: next.empty } : {}),
    };
  }
}
