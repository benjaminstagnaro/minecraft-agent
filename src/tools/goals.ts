import pathfinderPkg from 'mineflayer-pathfinder';

const { goals } = pathfinderPkg;

/** Altura de los ojos del jugador sobre sus pies. */
export const EYE_HEIGHT = 1.62;
/**
 * Distancia máxima ojos → centro del bloque para picarlo. El servidor permite 4,5 (+1 de
 * margen); usamos menos para no quedar justo en el borde.
 */
export const DEFAULT_REACH = 4.2;

interface Point {
  x: number;
  y: number;
  z: number;
}

/** ¿Desde un bot parado en `feet` se alcanza con la mano el bloque en `block`? */
export function withinReach(feet: Point, block: Point, reach = DEFAULT_REACH): boolean {
  const dx = feet.x + 0.5 - (block.x + 0.5);
  const dy = feet.y + EYE_HEIGHT - (block.y + 0.5);
  const dz = feet.z + 0.5 - (block.z + 0.5);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= reach;
}

/**
 * Objetivo del pathfinder: "quedar con el bloque al alcance de la mano".
 *
 * Por qué no usamos `GoalLookAtBlock` del pathfinder: ese exige LÍNEA DE VISIÓN con el mundo
 * actual. En robles con hojas bajas, de lejos las hojas tapan el tronco y de cerca la
 * cabeza queda dentro de las hojas, así que ningún punto sirve y el pathfinder dice "no hay
 * camino" (falló de forma intermitente en la prueba e2e según la forma del árbol). El
 * servidor no exige línea de visión para picar, solo distancia; esto refleja esa regla.
 */
export class GoalWithinReach extends goals.Goal {
  constructor(
    private readonly block: Point,
    private readonly reach = DEFAULT_REACH,
  ) {
    super();
  }

  heuristic(node: Point): number {
    const dx = node.x - this.block.x;
    const dz = node.z - this.block.z;
    const dy = node.y + EYE_HEIGHT - (this.block.y + 0.5);
    return Math.max(0, Math.sqrt(dx * dx + dz * dz) + Math.abs(dy) - this.reach);
  }

  isEnd(node: Point): boolean {
    return withinReach(node, this.block, this.reach);
  }

  override hasChanged(): boolean {
    return false;
  }

  override isValid(): boolean {
    return true;
  }
}

/**
 * Objetivo para poner un bloque en `target`: tenerlo al alcance SIN estar parado en esa celda
 * (ni con los pies ni con la cabeza), porque el servidor no deja poner un bloque donde hay
 * alguien. Mismo motivo que GoalWithinReach para no usar GoalPlaceBlock del pathfinder: exige
 * línea de visión.
 */
export class GoalPlaceNear extends GoalWithinReach {
  constructor(private readonly target: Point) {
    super(target);
  }

  override isEnd(node: Point): boolean {
    const occupies =
      node.x === this.target.x &&
      node.z === this.target.z &&
      (node.y === this.target.y || node.y + 1 === this.target.y);
    return !occupies && super.isEnd(node);
  }
}
