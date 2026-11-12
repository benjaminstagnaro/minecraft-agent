# Minecraft Agent: agente de IA que juega y construye en Minecraft

## Quién soy y cómo quiero trabajar

- Soy Benjamín, estudiante de tercer año de Ingeniería en Informática (mención Inteligencia Artificial) en Duoc UC, Chile.
- Este es un proyecto **personal, por gusto**, para mi GitHub y mi LinkedIn. Tiene que ser entretenido de construir y quedar presentable como portafolio.
- **Responde siempre en español**, directo y paso a paso, en lenguaje simple.
- **Tú diriges el proyecto.** Si ves algo que se puede hacer mejor, propónlo y hagámoslo; yo te sigo.
- **Cambios chicos y seguros.** No cambies demasiadas cosas a la vez. Cada etapa debe quedar funcionando antes de pasar a la siguiente.
- **Sé honesto.** Si algo no está probado, dilo. No digas que algo funciona sin haberlo corrido.
- Cuando algo requiera que yo haga una acción (entrar al juego, aceptar algo, crear una cuenta, poner una API key), dímelo explícitamente y espera a que confirme.

## La idea

Un bot que entra a un servidor de Minecraft **como un jugador más** y una IA (Claude) que decide qué hace. Le hablo por el chat del juego en lenguaje natural:

```
@bot sígueme
@bot junta 20 troncos de roble
@bot construye una casa estilo Miami acá
```

y el agente observa el mundo, planifica, usa herramientas (moverse, picar, recolectar, craftear, poner bloques), revisa el resultado y sigue hasta terminar o explicar por qué no pudo.

Inspiración: el paper **Voyager** (NVIDIA), un agente con LLM que aprende a jugar Minecraft. Este proyecto es una versión más práctica y conversacional.

## Reglas importantes (no negociables)

1. **Nunca conectar el bot a mi mundo "Miami extremo".** Es un mundo hardcore vanilla; un bug podría costarme el mundo. El bot vive **solo en un servidor de pruebas local** con un mundo aparte (o una copia).
2. **Secretos fuera de git.** La API key de Anthropic va en `.env`, que está en `.gitignore`. Nunca imprimir ni loguear la key.
3. **Límites de costo de IA.** Cada tarea tiene un máximo de pasos/llamadas al modelo (configurable) y el agente se detiene si lo alcanza. Loguear tokens usados por tarea.
4. **El servidor de pruebas y sus mundos no se suben a GitHub** (`server/` en `.gitignore`).

## Versión de Minecraft (revisar primero)

- Yo juego en **Java Edition 26.3**.
- Mineflayer suele demorar en soportar las versiones nuevas. **Primer paso del proyecto:** revisar qué versiones soporta la última versión de `mineflayer` / `minecraft-data`.
- Si 26.3 no está soportada, el servidor de pruebas usa **la versión más nueva que Mineflayer soporte**, y yo me conecto a ese servidor con el launcher en esa versión. No es problema porque es un mundo aparte.
- Dejar la versión elegida anotada en la sección "Estado actual" de este archivo.

## Stack

| Parte | Tecnología |
|---|---|
| Lenguaje | TypeScript sobre Node.js (LTS) |
| Bot | `mineflayer` + plugins: `mineflayer-pathfinder`, `mineflayer-collectblock`, `mineflayer-tool`, `prismarine-viewer` (vista 3D) |
| IA | API de Claude (SDK oficial `@anthropic-ai/sdk`) con **tool use** |
| Servidor de pruebas | **Vanilla** oficial de Mojang, local, `online-mode=false` para que el bot entre sin cuenta (Paper descartado: rompe el salto de mineflayer, ver "Estado actual") |
| Panel web (etapa avanzada) | Página simple que muestra el razonamiento del agente y la vista 3D |
| Calidad | ESLint + Prettier, tests con Vitest |

Modelos de Claude: usar los actuales; verificar nombres vigentes en https://docs.claude.com antes de fijarlos. Idea: un modelo rápido y barato (tipo Haiku) para órdenes simples y uno más capaz (tipo Sonnet/Opus) para planificar construcciones. El modelo va en `.env`, no en el código.

## Arquitectura

```
Chat de Minecraft ──► Bot (Mineflayer) ──► Agente (loop)
                         ▲                     │
                         │                     ▼
                    Herramientas ◄────── Claude (tool use)
                    (acciones reales)
```

**Loop del agente:**
1. **Observar:** posición, vida/hambre, inventario, bloques y entidades cercanas, hora del día.
2. **Pensar:** enviar la orden + observación a Claude con la lista de herramientas.
3. **Actuar:** ejecutar la herramienta que pidió Claude.
4. **Revisar:** devolver el resultado (éxito o error con detalle) a Claude.
5. Repetir hasta que Claude diga "terminé", se pida cancelar (`@bot para`) o se alcance el límite de pasos.

**Herramientas iniciales (tool use):**
- `get_status()`: posición, vida, hambre, inventario
- `look_around(radius)`: bloques y entidades relevantes cerca
- `go_to(x, y, z)` / `follow_player(name)` / `stop()`
- `mine_block(block_name, count)` / `collect_item(item, count)`
- `craft(item, count)` (usa mesa de crafteo si hace falta)
- `place_block(block, x, y, z)`
- `build_blueprint(blueprint_id, origin)`: ejecuta un plano
- `chat(message)`: responder al jugador

Cada herramienta: valida parámetros, tiene timeout, devuelve un resultado claro en texto/JSON y **nunca deja al bot colgado**.

**Planos de construcción:** Claude genera un JSON con bloques en coordenadas relativas (`[{ "x":0, "y":0, "z":0, "block":"white_concrete" }, ...]`). Un ejecutor determinista los coloca en orden (de abajo hacia arriba, primero estructura y después detalles), maneja andamios y reporta progreso. Validar el plano antes de construir (tamaño máximo, bloques válidos).

## Estructura de carpetas propuesta

```
minecraft-agent/
├── CLAUDE.md
├── README.md
├── .env.example          # ANTHROPIC_API_KEY=, MODELO_RAPIDO=, MODELO_PLANIFICADOR=, MC_HOST=, MC_PORT=, MC_VERSION=, BOT_NAME=, MAX_STEPS=
├── src/
│   ├── index.ts          # arranque
│   ├── bot/              # conexión Mineflayer, plugins, eventos de chat
│   ├── tools/            # una herramienta por archivo + registro
│   ├── agent/            # loop, prompts, memoria, límites
│   ├── building/         # planos, validación y ejecutor
│   └── web/              # panel (etapa avanzada)
├── blueprints/           # planos guardados (JSON)
├── tests/
├── scripts/              # descargar/levantar servidor de pruebas
└── server/               # servidor de pruebas (en .gitignore)
```

## Etapas (cada una termina funcionando)

1. **Base:** proyecto TypeScript, servidor de pruebas levantado, el bot entra y saluda. Comandos fijos: `@bot sígueme`, `@bot para`, `@bot ven`.
   *Listo cuando:* el bot me sigue por el mapa sin quedarse pegado.
2. **Acciones:** herramientas de minar, recolectar, craftear y poner bloques, probadas con comandos fijos (sin IA).
   *Listo cuando:* `@bot junta 10 troncos` funciona solo con código.
3. **Cerebro:** se conecta Claude con tool use y el loop del agente. Órdenes en lenguaje natural.
   *Listo cuando:* entiende pedidos variados y explica en el chat lo que hace o por qué falla.
4. **Construcción en creativo:** Claude genera planos y el ejecutor construye (casa estilo Miami, torre, puente).
   *Listo cuando:* construye 3 estructuras distintas a partir de una frase.
5. **Survival:** antes de construir calcula materiales, los junta/craftea y después construye.
6. **Memoria y habilidades:** recuerda lugares ("mi casa", "la mina") y guarda secuencias exitosas como habilidades reutilizables (estilo Voyager).
7. **Panel web + pulido:** página con el razonamiento paso a paso y vista 3D, README con GIFs, video demo para LinkedIn.

## Entregables de portafolio

- README en español con GIFs/video, diagrama de arquitectura y cómo levantarlo.
- Video demo corto (yo grabo; se edita después).
- Repo público en GitHub con commits ordenados por etapa.

## Convenciones

- Commits en español, estilo `feat(tools): ...`, `fix(agent): ...`.
- Rama por etapa (`etapa-1-base`, etc.) y merge a `main` cuando funciona.
- Código con nombres claros; comentarios en español explicando el "por qué".
- Logs legibles: qué pidió el jugador, qué herramienta se usó, resultado, tokens.

## Estado actual

- [x] Etapa 1: Base: prueba end-to-end `npm run smoke:follow` OK 7/7 (2 corridas) y **probada por Benjamín en el juego** (sígueme/para/ven, perderlo de vista, torre inalcanzable, cruzar el mar, parkour, bayas). Cerrada: merge a `main` y publicada en https://github.com/benjaminstagnaro/minecraft-agent (2026-11-11).
- [ ] Etapa 2: Acciones (en curso, rama `etapa-2-acciones`): ✅ `estado`, ✅ `junta N <bloque>` (smoke:collect 4/4), ✅ `craftea N <ítem>` (smoke:craft 7/7). Falta: `pon <bloque>` y la prueba de Benjamín en el juego.
  - "junta" termina cada árbol (de abajo hacia arriba) antes de pasar a otro y prefiere no romper hojas (reportado por Benjamín en el juego; smoke:collect con 4 robles pegados: 3/3, a lo más 1 árbol a medias).
- Versión del servidor de pruebas: **vanilla 26.1.2** (protocolo 775). Benjamín se conecta con el launcher en **26.1.2**.
  - mineflayer 4.39.0 (última release, sep 2026) llega hasta 26.1.x; 26.3 (protocolo 777) no está soportada.
  - Java 25: los scripts usan el del launcher de Minecraft automáticamente (el `java` del PATH es Java 8).

### Hallazgos técnicos (no repetir la investigación)

- **Paper 26.1.2 no sirve con mineflayer**: corrige ("teletransporta de vuelta") cada movimiento en que el bot toca una pared (~13/s); eso borra el `onGround` y el bot no puede saltar escalones. En vanilla: 0 correcciones. Medido con un bot de diagnóstico y el evento `forcedMove`.
- Descartado como causa: el paquete `tick_end` (mineflayer no lo envía; necesario recién en 26.3, ya arreglado en mineflayer master, PR #4137) y el flag `hasHorizontalCollision`. Ninguno cambió nada en 26.1.
- `bot.game.hardcore` es siempre `false` en 26.1 (bug de mineflayer): la protección lee `isHardcore` del paquete de login crudo.
- Bloques atravesables dañinos (`sweet_berry_bush`, `wither_rose`, `powder_snow`, `soul_fire`): no basta con `blocksToAvoid`, porque el bot los roza con su caja de 0,6 al doblar. Se usa además un costo por casilla vecina (`exclusionAreasStep`, `src/bot/pathing.ts`). La prueba e2e mide la vida del agente por RCON.
- `GoalLookAtBlock` del pathfinder exige línea de visión con el mundo actual: con árboles de hojas bajas da "No path" intermitente. Usar `GoalWithinReach` (`src/tools/goals.ts`): el servidor solo exige distancia para picar.
- Crafteo con mineflayer en 26.1: los clics salen sin esperar confirmación y chocan con las actualizaciones de `stateId` del servidor (receta a medias, ingredientes atrapados en la cuadrícula 2x2). `craftItem.ts` espera respuesta tras cada clic, sincroniza con `_syncWindow`, vacía la cuadrícula (`close_window` 0) y verifica contra el inventario real. Issue relacionado abierto: mineflayer #4161 (`set_player_inventory` mal mapeado).
- `tsx -e` con imports `.ts` falla en silencio en este equipo: para scripts temporales, usar un archivo en `scripts/`.
- Para buscar procesos del agente, filtrar por `src[/\]index.ts` en la línea de comando (NO por `minecraft-agent`: `node --import tsx src/index.ts` no incluye la carpeta y el filtro no lo ve).
- Windows: detener un proceso `npm run ...` deja vivo al hijo `node`. Revisar procesos huérfanos (dos agentes con el mismo nombre se expulsan mutuamente; el agente ahora detecta `duplicate_login` y no reintenta).
