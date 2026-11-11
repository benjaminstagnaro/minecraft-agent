import type { Bot } from 'mineflayer';
import type { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import type { Logger } from '../logger.js';

const { Movements, goals } = pathfinderPkg;

type Entity = Bot['entity'];

/**
 * Controla el movimiento del bot hacia un jugador: seguirlo ("sígueme"), ir una vez
 * a su posición ("ven") y detenerse ("para").
 *
 * El pathfinder hace el trabajo pesado (calcular rutas). Esta clase agrega lo que le
 * falta para que el bot no "se quede pegado":
 *  - Un vigilante (watchdog) que revisa cada medio segundo si el bot avanza.
 *  - Si no avanza estando lejos, reintenta (salta y recalcula la ruta).
 *  - Si el jugador sale del rango de visión, va a su última posición conocida y lo
 *    vuelve a seguir cuando reaparece.
 *  - "ven" tiene un tiempo máximo: nunca queda esperando para siempre.
 */

export interface MovementOptions {
  /** Distancia (bloques) a la que se queda del jugador al seguirlo. */
  followDistance: number;
  /** Cada cuánto revisa el vigilante (ms). */
  watchdogIntervalMs: number;
  /** Tiempo sin avanzar (ms) para considerarse atascado. */
  stuckAfterMs: number;
  /** Tiempo máximo para completar un "ven" (ms). */
  comeTimeoutMs: number;
}

const DEFAULT_OPTIONS: MovementOptions = {
  followDistance: 2,
  watchdogIntervalMs: 500,
  stuckAfterMs: 3000,
  comeTimeoutMs: 60_000,
};

type Mode =
  | { kind: 'idle' }
  | { kind: 'following'; username: string }
  | { kind: 'coming'; username: string; startedAt: number };

// Si el bot se mueve menos que esto entre revisiones, cuenta como "quieto".
const MIN_PROGRESS_BLOCKS = 0.15;
// Intentos de desatascarse antes de pedir ayuda en el chat.
const RECOVERIES_BEFORE_ASKING_HELP = 3;
// No repetir el mismo aviso en el chat más seguido que esto.
const CHAT_COOLDOWN_MS = 30_000;

export class MovementController {
  private mode: Mode = { kind: 'idle' };
  private readonly options: MovementOptions;
  private watchdog: NodeJS.Timeout | undefined;

  /** Entidad a la que apunta el objetivo actual del pathfinder (para detectar si cambió). */
  private trackedEntity: Entity | undefined;
  private lastKnownTargetPos: Vec3 | undefined;
  private lastBotPos: Vec3 | undefined;
  private stillSinceMs: number | undefined;
  private recoveries = 0;
  private lastHelpRequestMs = 0;
  private noPathCount = 0;
  private disposed = false;

  constructor(
    private readonly bot: Bot,
    private readonly log: Logger,
    private readonly say: (message: string) => void,
    options: Partial<MovementOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    const movements = new Movements(bot);
    // No rompe bloques para abrirse paso: si te sigue a tu casa, no te destruye las paredes.
    movements.canDig = false;
    movements.allowSprinting = true;
    movements.allowParkour = true;
    bot.pathfinder.setMovements(movements);

    bot.on('goal_reached', this.onGoalReached);
    bot.on('path_update', this.onPathUpdate);
    bot.on('death', this.onDeath);
  }

  get currentMode(): Mode['kind'] {
    return this.mode.kind;
  }

  follow(username: string): void {
    const target = this.findPlayerEntity(username);
    if (!target) {
      this.say(`No te veo, ${username}. Acércate un poco y vuelve a pedírmelo.`);
      return;
    }
    this.resetProgress();
    this.mode = { kind: 'following', username };
    this.followEntity(target);
    this.startWatchdog();
    this.log.info(`Siguiendo a ${username}`);
    this.say(`Te sigo, ${username}.`);
  }

  comeTo(username: string): void {
    const target = this.findPlayerEntity(username);
    if (!target) {
      this.say(`No te veo, ${username}. Estoy muy lejos o en otra dimensión.`);
      return;
    }
    this.resetProgress();
    this.mode = { kind: 'coming', username, startedAt: Date.now() };
    this.lastKnownTargetPos = target.position.clone();
    this.setGoalNear(target.position);
    this.startWatchdog();
    this.log.info(`Yendo hacia ${username}`, this.formatPos(target.position));
    this.say('Voy para allá.');
  }

  /** Detiene todo movimiento. `quiet` = no avisar por chat (por ejemplo al desconectarse). */
  stop(quiet = false): void {
    const wasMoving = this.mode.kind !== 'idle';
    this.mode = { kind: 'idle' };
    this.stopWatchdog();
    this.trackedEntity = undefined;
    this.bot.pathfinder.setGoal(null);
    this.bot.clearControlStates();
    if (wasMoving) this.log.info('Movimiento detenido');
    if (!quiet) this.say('Listo, me quedo aquí.');
  }

  /** Libera timers y listeners. Se llama cuando el bot se desconecta. */
  dispose(): void {
    this.disposed = true;
    this.stopWatchdog();
    this.mode = { kind: 'idle' };
    this.bot.off('goal_reached', this.onGoalReached);
    this.bot.off('path_update', this.onPathUpdate);
    this.bot.off('death', this.onDeath);
  }

  // ───────────────────────────── eventos del pathfinder ─────────────────────────────

  private readonly onGoalReached = (): void => {
    if (this.mode.kind !== 'coming') return;
    const { username } = this.mode;
    this.finish();
    this.log.info(`Llegué donde ${username}`);
    this.say('Aquí estoy.');
  };

  private readonly onPathUpdate = (result: { status: string }): void => {
    if (result.status !== 'noPath') {
      if (result.status === 'success') this.noPathCount = 0;
      return;
    }
    this.noPathCount++;
    this.log.debug(`El pathfinder no encontró ruta (intento ${this.noPathCount})`);

    // Para "ven" no tiene sentido insistir eternamente si no hay camino.
    if (this.mode.kind === 'coming' && this.noPathCount >= 3) {
      this.finish();
      this.say('No encuentro un camino hasta ti. ¿Me ayudas a acercarme?');
    }
  };

  private readonly onDeath = (): void => {
    if (this.mode.kind === 'idle') return;
    this.log.warn('El bot murió; dejo de moverme');
    this.stop(true);
  };

  // ─────────────────────────────────── vigilante ───────────────────────────────────

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => this.tick(), this.options.watchdogIntervalMs);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private tick(): void {
    // Cualquier error aquí se loguea: el vigilante nunca debe botar el proceso.
    try {
      if (this.mode.kind === 'following') this.tickFollowing(this.mode.username);
      else if (this.mode.kind === 'coming') this.tickComing(this.mode);
    } catch (error) {
      this.log.error('Error en el vigilante de movimiento', error);
    }
  }

  private tickFollowing(username: string): void {
    if (!this.bot.players[username]) {
      this.log.info(`${username} salió del servidor; dejo de seguir`);
      this.stop(true);
      return;
    }

    const target = this.findPlayerEntity(username);
    if (target) {
      this.lastKnownTargetPos = target.position.clone();
      // Si el jugador salió de rango y volvió (o murió y reapareció), mineflayer crea una
      // entidad NUEVA. El objetivo viejo apuntaría a una entidad que ya no se actualiza.
      if (target !== this.trackedEntity) {
        this.log.debug(`Vuelvo a ver a ${username}; retomo el seguimiento`);
        this.followEntity(target);
      }
    } else if (this.trackedEntity && this.lastKnownTargetPos) {
      // Lo perdimos de vista: ir a donde lo vimos por última vez.
      this.log.info(`Perdí de vista a ${username}; voy a su última posición conocida`);
      this.trackedEntity = undefined;
      this.setGoalNear(this.lastKnownTargetPos);
    }

    const goalPos = target?.position ?? this.lastKnownTargetPos;
    if (goalPos) this.checkStuck(goalPos, this.options.followDistance + 2);
  }

  private tickComing(mode: Extract<Mode, { kind: 'coming' }>): void {
    if (Date.now() - mode.startedAt > this.options.comeTimeoutMs) {
      this.finish();
      this.say('No logré llegar a tiempo. Me quedo aquí.');
      return;
    }
    if (this.lastKnownTargetPos) this.checkStuck(this.lastKnownTargetPos, 3);
  }

  /**
   * Detecta si el bot está "pegado": lejos del objetivo y sin avanzar.
   * `closeEnough` = distancia a la que estar quieto es normal (ya llegó).
   */
  private checkStuck(goalPos: Vec3, closeEnough: number): void {
    const botPos = this.bot.entity.position;
    const distance = botPos.distanceTo(goalPos);
    const moved = this.lastBotPos ? botPos.distanceTo(this.lastBotPos) : Infinity;
    this.lastBotPos = botPos.clone();

    // Cerca del objetivo, o avanzando, o poniendo/rompiendo bloques: todo bien.
    const busy = this.bot.pathfinder.isBuilding() || this.bot.pathfinder.isMining();
    if (distance <= closeEnough || moved >= MIN_PROGRESS_BLOCKS || busy) {
      this.stillSinceMs = undefined;
      if (distance <= closeEnough) this.recoveries = 0;
      return;
    }

    const now = Date.now();
    this.stillSinceMs ??= now;
    if (now - this.stillSinceMs < this.options.stuckAfterMs) return;

    this.stillSinceMs = undefined;
    this.recoveries++;
    this.log.warn(
      `Atascado a ${distance.toFixed(1)} bloques del objetivo (intento de recuperación ${this.recoveries})`,
    );
    this.tryToGetUnstuck();

    if (
      this.recoveries >= RECOVERIES_BEFORE_ASKING_HELP &&
      now - this.lastHelpRequestMs > CHAT_COOLDOWN_MS
    ) {
      this.lastHelpRequestMs = now;
      this.say('Estoy atascado, no encuentro cómo llegar. Acércate o dime "@bot para".');
    }
  }

  /** Desatascarse: saltar un momento y forzar que el pathfinder recalcule la ruta. */
  private tryToGetUnstuck(): void {
    this.bot.pathfinder.setGoal(null);
    this.bot.setControlState('jump', true);
    setTimeout(() => {
      if (this.disposed) return;
      this.bot.setControlState('jump', false);
      this.reapplyGoal();
    }, 400);
  }

  private reapplyGoal(): void {
    if (this.mode.kind === 'following') {
      const target = this.findPlayerEntity(this.mode.username);
      if (target) this.followEntity(target);
      else if (this.lastKnownTargetPos) this.setGoalNear(this.lastKnownTargetPos);
    } else if (this.mode.kind === 'coming' && this.lastKnownTargetPos) {
      this.setGoalNear(this.lastKnownTargetPos);
    }
  }

  // ─────────────────────────────────── utilidades ───────────────────────────────────

  private followEntity(entity: Entity): void {
    this.trackedEntity = entity;
    // dynamic=true: el pathfinder recalcula a medida que el jugador se mueve.
    this.bot.pathfinder.setGoal(new goals.GoalFollow(entity, this.options.followDistance), true);
  }

  private setGoalNear(pos: Vec3): void {
    this.bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  }

  private finish(): void {
    this.mode = { kind: 'idle' };
    this.stopWatchdog();
    this.trackedEntity = undefined;
    this.bot.pathfinder.setGoal(null);
    this.bot.clearControlStates();
  }

  private resetProgress(): void {
    this.lastBotPos = undefined;
    this.stillSinceMs = undefined;
    this.recoveries = 0;
    this.noPathCount = 0;
  }

  private findPlayerEntity(username: string): Entity | undefined {
    const entity = this.bot.players[username]?.entity;
    // Puede existir el jugador (en la lista de tab) sin entidad: está fuera de rango.
    return entity?.isValid === false ? undefined : entity;
  }

  private formatPos(pos: Vec3): string {
    return `(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})`;
  }
}
