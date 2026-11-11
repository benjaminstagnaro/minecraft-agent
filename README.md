# Minecraft Agent

Un agente de IA que entra a Minecraft **como un jugador más** y obedece órdenes por el chat del juego.
Inspirado en [Voyager](https://voyager.minedojo.org/) (NVIDIA), pero práctico y conversacional:

```
@bot sígueme
@bot junta 20 troncos de roble          (etapa 2)
@bot construye una casa estilo Miami    (etapa 4)
```

> **Estado:** etapa 1 de 7 lista: el bot entra, saluda, te sigue, viene y se detiene.
> La IA (Claude con _tool use_) llega en la etapa 3.

## Cómo funciona (etapa 1)

```
Chat de Minecraft ──► Bot (Mineflayer) ──► Comandos fijos ──► Controlador de movimiento
                                                               (pathfinder + vigilante anti-atascos)
```

- **Mineflayer** conecta el bot al servidor como si fuera un cliente real.
- **mineflayer-pathfinder** calcula rutas (A\*) por el terreno.
- Un **vigilante** propio revisa cada 0,5 s si el bot avanza. Si se queda pegado, salta y recalcula
  la ruta. Si pierde de vista al jugador, va a su última posición conocida y lo retoma al verlo.

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

| Comando        | Qué hace                                       |
| -------------- | ---------------------------------------------- |
| `@bot sígueme` | Te sigue a ~2 bloques, rodeando obstáculos     |
| `@bot ven`     | Va una vez hasta donde estás y avisa al llegar |
| `@bot para`    | Se detiene donde está                          |
| `@bot ayuda`   | Lista los comandos                             |

También acepta variantes como `@bot seguime`, `@bot ven acá` o `@bot detente por favor`.

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
| `npm run smoke:follow`            | **Prueba end-to-end** en el servidor real (ver abajo)              |

### Prueba end-to-end

`npm run smoke:follow` conecta un segundo bot, "Probador", que actúa como jugador. Construye por RCON una
arena en el cielo con un muro de una sola abertura y un escalón, y verifica que el agente:

- lo **siga** por un recorrido de ~80 bloques rodeando obstáculos (a ≤ 5 bloques),
- se **quede quieto** tras `para` mientras el probador se aleja,
- **llegue** tras `ven` desde detrás del muro.

Al terminar borra la arena y deja el mundo como estaba. Resultado actual: **6/6 chequeos** (ejecutado dos veces).

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
- **Vitest en Windows.** Si la terminal abre la carpeta como `c:\` (minúscula, típico de VS Code),
  Vitest carga su módulo dos veces y todos los tests fallan. `scripts/vitest.mjs` normaliza la ruta.

## Estructura

```
src/
├── index.ts            arranque, protecciones y reconexión automática
├── config.ts           configuración validada con zod
├── logger.ts           logs legibles (y enmascara API keys por si acaso)
└── bot/
    ├── agentBot.ts     conexión, saludo, chat → comandos
    ├── commands.ts     parser de comandos ("@bot sígueme", etc.)
    ├── movement.ts     seguir / venir / parar + vigilante anti-atascos
    └── safety.ts       las tres capas de seguridad
scripts/                servidor de pruebas (setup, start, RCON) y prueba end-to-end
tests/                  tests unitarios
```

## Hoja de ruta

1. ✅ **Base**: el bot entra, saluda y te sigue sin quedarse pegado
2. **Acciones**: minar, recolectar, craftear, poner bloques (sin IA)
3. **Cerebro**: Claude con _tool use_, órdenes en lenguaje natural
4. **Construcción en creativo**: Claude diseña planos y un ejecutor los construye
5. **Survival**: calcula materiales, los junta y construye
6. **Memoria y habilidades**: recuerda lugares y reutiliza secuencias exitosas (estilo Voyager)
7. **Panel web**: razonamiento paso a paso + vista 3D
