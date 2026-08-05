# FrienDamas — Contexto del proyecto

Juego de damas (checkers) online con 3 modos: **vs IA**, **2 Jugadores** (local) y **Online** (Socket.IO).

## Estructura

```
juegodamas/
├── front/
│   ├── damas.html      ← TODO el frontend (CSS + JS en un solo archivo, ~1300 líneas)
│   └── vercel.json     ← config estática Vercel
├── server/
│   ├── server.js       ← Backend Express + Socket.IO + DB (~360 líneas)
│   ├── package.json    ← express, socket.io, cors, better-sqlite3, pg
│   ├── render.yaml     ← config deploy Render
│   └── game.db         ← SQLite local (solo desarrollo)
└── vercel.json         ← config raíz Vercel (estático)
```

## Despliegue (IMPORTANTE)

- **Frontend**: Vercel — https://friendamas.vercel.app (servido estáticamente, `vercel.json` apunta `damas.html`)
- **Backend**: Render — https://friendamas-server.onrender.com (auto-deploy de `server/`)
- **Flujo de deploy**: push a GitHub `main` → auto-deploy en Render/Vercel (esperar 1-2 min)
- El frontend conecta con el socket del servidor definido en `connectSocket()` (cambia según origen: localhost:3001 en dev, URL de Render en producción)
- **CORS**: `server.js:17` — permite localhost:3001, vercel, y `*`

## Base de datos

Doble motor vía `DATABASE_URL`:
- Si existe `DATABASE_URL` → **PostgreSQL** (producción en Render, requiere `pg`)
- Si no → **SQLite** local (`better-sqlite3`, archivo `server/game.db`)
- `dbSql()` (`server.js:78-80`) convierte `$N` → `?` para SQLite — **usarlo siempre** en queries

### Esquema (server.js:24-63)
- `rooms`: id, code (único 6 chars), status (waiting/playing/finished), turn (GOLD/BLACK), board_state (JSON string), gold_captured/black_captured (JSON), **gold_time/black_time** (segundos restantes), created_at
- `players`: id, room_id, socket_id, name, color (GOLD/BLACK), connected (0/1)
- `moves`: historial de jugadas (from_row/from_col/to_row/to_col/captures)
- `chat_messages`: historial de chat

### Cache en memoria
`activeRooms` (Map, `server.js:184-198`) guarda `{ room, players, code, themeMap }`.
- `themeMap = { GOLD: índiceTema, BLACK: índiceTema }` — colores elegidos por cada jugador
- `loadRoomToCache()` preserva `themeMap` existente
- `-1` como índice de tema = forzar color default (blanco/negro según modo claro/oscuro)

## Handlers Socket.IO (server.js)

| Evento | Función | Notas |
|--------|---------|-------|
| `create_room` | recibe `{playerName, p1Color}` | crea sala, asigna GOLD, guarda themeMap |
| `join_room` | recibe `{code, name, p1Color}` | asigna BLACK; si nombre existe con `connected===0` → reconexión; `connected===1` → error "Nombre ya en uso"; si colores iguales → BLACK=-1 |
| `reconnect_room` | `{code, name}` | devuelve estado completo: players, turn, board_state, gold/black_time, lastMove, moves, chat, themeMap |
| `make_move` | data con board_state, next_turn, capturas, tiempos | persiste board + tiempos en DB, emite `opponent_move` |
| `resign` / `draw_offer` / `draw_response` | | fin de partida / tablas |
| `disconnect` | | marca offline, elimina sala si nadie conectado tras 5 min |

## Frontend — Conceptos clave (front/damas.html)

### Reglas del juego
- Tablero 8x8. Filas 0-2 = BLACK (arriba), filas 5-7 = GOLD (abajo)
- `board[r][c]`: EMPTY=0, BLACK=1, BLACK_KING=2, GOLD=-1, GOLD_KING=-2
- Reyes con vuelo libre. Captura obligatoria (ley de captura)
- `applyMv(b,r,c,mv)` devuelve `{board, captured}`

### Temas / colores
- `THEMES` (`damas.html:461-466`): Oro, Rubí, Zafiro, Esmeralda (4 temas, Amatista eliminado)
- `p1Color`/`p2Color` = índices del array THEMES
- `applyTheme(pIdx, oIdx)` (`546-559`): `--p1` = mis fichas, `--p2` = fichas rival
  - **Online**: usa el color primario del tema del rival (`to.p`)
  - **IA/Local**: rival siempre blanco (dark) / negro (light) vía `setDefaultPieces()`
  - **swap** = `gameMode==='online' && myOnlineColor==='BLACK'`: intercambia índices porque el tablero está volteado (las clases `.gp`→`--p1` son el bando de abajo)
- `-1` como índice → `setDefaultPieces()` fuerza blanco/negro según `isLight`

### Tablero volteado (online)
- `render()` (`970-990`): `flip = gameModeOnline && myOnlineColor==='BLACK'` → itera filas en reversa para que el jugador negro vea sus fichas abajo
- El jugador siempre es `.gp`/`--p1` (bando de abajo)

### Marcado de última jugada
- `lastMove = {from:{r,c}, to:{r,c}}` — usar SIEMPRE `.r`/`.c` (nunca `.row`/`.col`, bug recurrente en `opponentMoveHandler`)
- CSS `.tl.lm.from` (punto central) y `.tl.lm.to` (glow fuerte)

### Timer
- `startT()` no inicia si `gameMode==='ai'` (sin tiempo vs IA); relojes ocultos en AI
- En online los tiempos se persisten en DB y se restauran al reconectar
- `movesSinceCapture`: si llega a 40 sin capturas en IA → **empate técnico** automático

### IA (negamax + alpha-beta)
- `searchBestMove(b, color, budget, maxDepth)`: iterativo + quiescence + killers + tabla transposición
- Dificultad: `hard` → presupuesto 500ms / profundidad 10; `medium` → 160ms / 5
- `aiMove()` se dispara cuando `turn===BLACK`; listener `visibilitychange` la re-dispara al desbloquear el teléfono

### Reconexión online
- Botón "Reconectar" en el menú (código + nombre)
- Cliente restaura: board_state, turn, lastMove, gold/black_time, chat, themeMap, roomBadge
- `gameMode='online'`, `gameModeOnline=true`, luego `applyTheme()` y `startT()`

## Variables importantes del frontend

- `gameMode`: 'ai' | 'local' | 'online' (modo seleccionado en menú)
- `gameModeOnline`: boolean — true cuando hay partida online activa
- `myOnlineColor`: 'GOLD' (host) | 'BLACK' (join) | null
- `onlineRoomCode`: código de sala (mostrado en `roomBadge` durante la partida)
- `myOnlineName` / `onlineOpponentName`
- `roomBadgeCode` / `roomBadge`: badge copiable con el código de sala
- `isLight`: modo claro/oscuro (toggle header)

## Convenciones

- **NO añadir comentarios al código salvo que se pida**
- CSS y JS minificados en una línea dentro de `damas.html` — respetar ese estilo
- Errores de joiner de sala: `nameInput` NO debe ocultarse antes de verificar `res.error`
- `applyTheme` debe llamarse tras cambiar colores en online (ojo con `gameMode` vs `gameModeOnline`)
- Commits cortos en español que describan el cambio

## Verificación

- No hay tests automatizados. Probar manualmente:
  1. `npm install` en `server/` y `node server.js` (SQLite local, puerto 3001)
  2. Abrir `front/damas.html` o `http://localhost:3001`
  3. Probar los 3 modos, y online con 2 pestañas/ventanas (host + joiner)
