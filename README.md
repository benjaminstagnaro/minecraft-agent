# Minecraft Agent

Un agente de IA que entra a Minecraft **como un jugador más** y obedece órdenes por el chat del juego.
Inspirado en [Voyager](https://voyager.minedojo.org/) (NVIDIA), pero práctico y conversacional:

```
@bot sígueme
@bot junta 20 troncos de roble
@bot craftea un pico de madera
@bot construye una casa estilo Miami    (etapa 4)
```

> **Estado:** etapa 2 de 7: el bot te sigue, junta recursos, craftea y pone bloques con comandos
> fijos (falta la prueba final en el juego). La IA (Claude con _tool use_) llega en la etapa 3.

## Cómo funciona

```
Chat de Minecraft ──► Bot (Mineflayer) ──► Comandos fijos ──┬─► Controlador de movimiento
                                                             │   (pathfinder + vigilante anti-atascos)
                                                             └─► Ejecutor de acciones ──► Herramientas
                                                                 (una a la vez, cancelable,   (junta, craftea,
                                                                  con tiempo máximo)           pon, estado)
```

- **Mineflayer** conecta el bot al servidor como si fuera un cliente real.
- **mineflayer-pathfinder** calcula rutas (A\*) por el terreno.
- Un **vigilante** propio revisa cada 0,5 s si el bot avanza. Si se queda pegado, salta y recalcula
  la ruta. Si pierde de vista al jugador, va a su última posición conocida y lo retoma al verlo.
- Las **herramientas** (`src/tools/`) ya tienen la forma que usará Claude en la etapa 3: nombre,
  descripción, parámetros validados con zod y un resultado claro. Todas se pueden cancelar con
  `@bot para` y tienen un tiempo máximo: nunca dejan al bot colgado.

## Seguridad primero

El bot **nunca** debe entrar a un mundo real. Por eso hay tres capas de protección:

1. **Solo localhost**: se niega a conectarse a otro host salvo `ALLOW_REMOTE_SERVER=true`.
2. **Marca en el MOTD**: antes de cada conexión hace _ping_ y exige que el servidor muestre
   `[minecraft-agent]`. Un mundo abierto a LAN o cualquier otro servidor no la tiene.
3. **Anti-hardcore**: si el mundo es hardcore, se desconecta al instante.

Además, el servidor de pruebas solo escucha en `127.0.0.1` y la API key (etapa 3) vive en `.env`, fuera de git.

## Requisitos

- Node.js 22.12+ (probado con Node 24)
- Java 25+ para el servidor. Si tienes el launcher de Minecraft con una versión 26.x instalada,
  el script usa ese Java solo y no tienes que instalar nada.
- Minecraft Java Edition **26.1.2** para conectarte tú (ver "Versión de Minecraft").

## Puesta en marcha

```bash
npm install
cp .env.example .env                       # ajusta si quieres (nombre del bot, etc.)

npm run server:setup                       # descarga el servidor oficial y lo configura
npm run server:setup -- --acepto-eula      # solo si aceptas el EULA: https://aka.ms/MinecraftEULA
npm run server:start                       # terminal 1: servidor de pruebas
npm run dev                                # terminal 2: el agente
```

Después abre Minecraft **26.1.2** → Multijugador → Conexión directa → `localhost` y escribe en el chat:

| Comando                    | Qué hace                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@bot sígueme`             | Te sigue a ~2 bloques, rodeando obstáculos                                                                                                                                                       |
| `@bot ven`                 | Va una vez hasta donde estás y avisa al llegar                                                                                                                                                   |
| `@bot para`                | Se detiene donde está                                                                                                                                                                            |
| `@bot ayuda`               | Lista los comandos                                                                                                                                                                               |
| `@bot estado`              | Vida, comida, posición e inventario                                                                                                                                                              |
| `@bot junta 10 troncos`    | Tala árboles **naturales** (nunca troncos de tus construcciones) y recoge lo que cae. También: tierra, arena, grava, piedra, carbón o un ID (`oak_log`)                                          |
| `@bot craftea 4 palos`     | Craftea con lo que tiene. Si hace falta, usa o pone una mesa de crafteo (y la fabrica). Si le falta algo, dice qué. También: tablones, mesa, pico de madera, antorchas, cofre...                 |
| `@bot pon tierra en x y z` | Pone un bloque de su inventario. Acepta coordenadas relativas a ti, como en los comandos: `@bot pon adoquines en ~2 ~ ~`. Explica si no puede (ocupado, sin apoyo, no lo tiene, hay alguien ahí) |

También acepta variantes como `@bot seguime`, `@bot recolecta diez troncos`, `@bot hazme una mesa`
o `@bot detente por favor`. **Una orden nueva reemplaza a la anterior** y `@bot para` detiene todo.

## Scripts

| Script                            | Para qué                                                           |
| --------------------------------- | ------------------------------------------------------------------ |
| `npm run dev`                     | Corre el agente (TypeScript directo con tsx)                       |
| `npm run build` / `npm start`     | Compila a `dist/` y corre la versión compilada                     |
| `npm run check`                   | Tipos + ESLint + Prettier + tests (todo junto)                     |
| `npm test`                        | Tests unitarios (Vitest)                                           |
| `npm run server:setup`            | Descarga y configura el servidor de pruebas                        |
| `npm run server:start`            | Inicia el servidor (Ctrl+C lo apaga guardando el mundo)            |
| `npm run server:cmd -- <comando>` | Manda un comando por RCON, ej: `npm run server:cmd -- op TuNombre` |
| `npm run smoke:follow`            | **Prueba end-to-end** de seguimiento (ver abajo)                   |
| `npm run smoke:collect`           | **Prueba end-to-end** de "junta troncos"                           |
| `npm run smoke:craft`             | **Prueba end-to-end** de crafteo                                   |
| `npm run smoke:place`             | **Prueba end-to-end** de "pon <bloque>"                            |

### Pruebas end-to-end

Las pruebas `smoke:*` corren contra el servidor real. Un segundo bot, "Probador", actúa como
jugador y usa RCON para armar el escenario en el cielo y verificar resultados. Al terminar,
todo se borra.

**`smoke:follow`** conecta un segundo bot, "Probador", que actúa como jugador. Construye por RCON una
arena en el cielo con un muro de una sola abertura, un escalón y una franja de arbustos de bayas, y verifica que el agente:

- lo **siga** por un recorrido de ~80 bloques rodeando obstáculos (a ≤ 5 bloques),
- **no se haga daño** en el camino (su vida se monitorea por RCON cada 0,4 s),
- se **quede quieto** tras `para` mientras el probador se aleja,
- **llegue** tras `ven` desde detrás del muro.

- y que **no rompa nada** al seguir (el muro queda intacto).

Resultado: **8/8**.

**`smoke:collect`** planta 4 robles naturales pegados (como en un bosque) y 2 "señuelos" de
construcción (troncos sin hojas y con hojas puestas a mano). Verifica que `junta 10 troncos` los
consiga, que **termine cada árbol antes de pasar a otro** (a lo más queda a medias el último),
que `para` lo detenga a mitad de la tarea, que explique cuando no hay suficientes y que **los
señuelos queden intactos**. Resultado: **5/5**.

**`smoke:craft`** le da materiales y le pide: tablones, palos, un pico sin tablones suficientes
(debe decir qué falta), un pico fabricando la mesa sin gastarse lo del pico, un cofre con la mesa
existente y un pico de piedra sin piedra. Resultado: **7/7** (6 corridas seguidas).

**`smoke:place`** le da tierra y adoquines y verifica que ponga un bloque en el suelo y otro
encima, que use coordenadas relativas (`~2 ~ ~`), que camine hasta un lugar lejano, que se corra
si está parado justo donde va el bloque, y que explique los casos imposibles: flotando sin apoyo,
lugar ocupado, no tiene el bloque, o hay un jugador ahí. Resultado: **9/9**.

## Decisiones técnicas (y bugs encontrados en el camino)

- **Versión de Minecraft: 26.1.2.** La última release de mineflayer (4.39.0) soporta hasta el
  protocolo 775 (familia 26.1). La 26.3 usa el 777 y todavía no está soportada.
- **Servidor vanilla, no Paper.** Primero usé Paper 26.1.2, pero el bot se quedaba pegado frente a
  cualquier escalón. Midiendo los paquetes descubrí que Paper rechaza ("teletransporta de vuelta")
  cada movimiento en que el bot _toca_ una pared: unas 13 correcciones por segundo. Cada corrección
  le quitaba el `onGround`, así que nunca podía saltar. En el servidor vanilla oficial, la misma
  prueba da **0 correcciones** y el bot pasa el escalón.
- **Bug de mineflayer con hardcore.** En 26.1, `bot.game.hardcore` siempre vale `false`, porque
  mineflayer busca `isHardcore` dentro de `worldState` y el campo viene en la raíz del paquete de
  login. La protección anti-hardcore lee el paquete crudo (ver `src/bot/safety.ts`, con test).
- **Arbustos de bayas.** Probando en el juego, el bot se pinchaba al cruzar bosques de abeto.
  El pathfinder trata como "seguro" todo bloque sin colisión, y el arbusto no tiene colisión.
  Primero lo agregué a los bloques a evitar (junto con la rosa marchita, la nieve polvo y el
  fuego de almas), pero la prueba e2e seguía marcando daño. El log mostró por qué: la caja del
  bot (0,6 de ancho) **rozaba** el arbusto al doblar junto a él. Solución: un costo extra por
  pasar al lado de un bloque dañino (`src/bot/pathing.ts`). Resultado: 0 daño.
- **Talar sin tocar construcciones.** Minecraft marca con `persistent=true` las hojas que pone un
  jugador. Un tronco solo se tala si tiene hojas **naturales** cerca de su copa; si no, se trata
  como parte de una construcción. Además, mientras trabaja, el bot solo puede romper en el camino
  hojas naturales y el bloque objetivo, nunca una pared tuya.
- **"No hay camino" hacia árboles con hojas bajas.** El objetivo `GoalLookAtBlock` del pathfinder
  exige línea de visión con el mundo actual: de lejos las hojas tapan el tronco y de cerca la
  cabeza queda dentro de ellas. Fallaba de forma intermitente según la forma del árbol. El servidor
  no exige línea de visión para picar, solo distancia, así que uso un objetivo propio "al alcance
  de la mano" (`src/tools/goals.ts`).
- **Crafteo poco confiable en mineflayer (26.1).** Mineflayer envía los clics de inventario sin
  esperar confirmación. Al encadenar crafteos (tronco → tablones → mesa), un clic salía antes de
  que llegara la actualización del servidor, con un `stateId` viejo; el servidor resincronizaba
  y la receta quedaba a medias (ingredientes "atrapados" en la cuadrícula). Solución en tres capas
  (`src/tools/craftItem.ts`): esperar la respuesta del servidor tras cada clic, verificar el
  resultado contra el inventario real sincronizado y, si algo quedó en la cuadrícula, devolverlo
  y reintentar. Así el bot nunca dice "Listo" sin haberlo comprobado.
- **Vitest en Windows.** Si la terminal abre la carpeta como `c:\` (minúscula, típico de VS Code),
  Vitest carga su módulo dos veces y todos los tests fallan. `scripts/vitest.mjs` normaliza la ruta.

## Estructura

```
src/
├── index.ts            arranque, protecciones y reconexión automática
├── config.ts           configuración validada con zod
├── logger.ts           logs legibles (y enmascara API keys por si acaso)
├── bot/
│   ├── agentBot.ts     conexión, saludo, chat → comandos
│   ├── commands.ts     parser de comandos ("@bot sígueme", "@bot junta 10 troncos"...)
│   ├── names.ts        nombres en español → bloques e ítems de Minecraft
│   ├── movement.ts     seguir / venir / parar + vigilante anti-atascos
│   ├── pathing.ts      configuración del pathfinder (no romper, esquivar bloques dañinos)
│   └── safety.ts       las tres capas de seguridad
└── tools/              herramientas (lo que usará Claude en la etapa 3)
    ├── runner.ts       ejecutor: una acción a la vez, validación, tiempo máximo, cancelación
    ├── collectBlock.ts "junta N <bloque>"
    ├── craftItem.ts    "craftea N <ítem>"
    ├── placeBlock.ts   "pon <bloque> en x y z"
    ├── placement.ts    dónde y cómo poner un bloque (apoyo, no encima de nadie)
    ├── goals.ts        objetivos del pathfinder "al alcance de la mano" (sin exigir línea de visión)
    ├── getStatus.ts    "estado"
    └── registry.ts     lista de herramientas
scripts/                servidor de pruebas (setup, start, RCON) y pruebas end-to-end
tests/                  tests unitarios
```

## Hoja de ruta

1. ✅ **Base**: el bot entra, saluda y te sigue sin quedarse pegado
2. 🔨 **Acciones**: ✅ juntar, ✅ craftear, ✅ poner bloques (sin IA). Falta la prueba final en el juego
3. **Cerebro**: Claude con _tool use_, órdenes en lenguaje natural
4. **Construcción en creativo**: Claude diseña planos y un ejecutor los construye
5. **Survival**: calcula materiales, los junta y construye
6. **Memoria y habilidades**: recuerda lugares y reutiliza secuencias exitosas (estilo Voyager)
7. **Panel web**: razonamiento paso a paso + vista 3D
