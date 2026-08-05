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

### Esquema (server.js:24-80)
- `rooms`: id, code (único 6 chars), status (waiting/playing/finished), turn (GOLD/BLACK), board_state (JSON string), gold_captured/black_captured (JSON), **gold_time/black_time** (segundos restantes), created_at
- `players`: id, room_id, socket_id, name, color (GOLD/BLACK), connected (0/1), **user_id** (nullable, se añade con ALTER en `dbInit`)
- `moves`: historial de jugadas (from_row/from_col/to_row/to_col/captures)
- `chat_messages`: historial de chat
- `users`: id, username (único), password_hash (bcrypt), elo (default 1200), wins/losses/draws, online (0/1), created_at
- `matches`: id, user_id, opponent_id, result (WIN/LOSS/DRAW), rated, elo_change, created_at — historial por jugador
- `friends`: id, user_id, friend_id, status (pending/active), action_user, created_at — relación par

**IMPORTANTE**: el adaptador SQLite (`dbSql`) convierte cada `$N` → `?`, así que **cada `$N` se usa UNA sola vez** por query (reutilizar `$1` rompe en SQLite; no usar `CASE WHEN f.user_id = $1 THEN ... $1`).

## Autenticación y REST API (server.js)

- **JWT** (`jsonwebtoken`) + **bcryptjs** (sin compilación nativa). `JWT_SECRET` env (default dev). Token expira en 30 días.
- `signToken(userId)` / `verifyToken(token)` / `requireAuth` (lee `Authorization: Bearer <token>`).
- **Socket.IO**: middleware `io.use()` lee `socket.handshake.auth.token`, asigna `socket.userId`. Presencia: `userSocketCounts` (Map) cuenta sockets por user; `users.online` = 1/0. Invitados (sin token) siguen jugando normal.
- `publicUser(u)`: `{id, username, elo, wins, losses, draws, online}`
- Elo: `eloExpectation()` + `ELO_K=32`, `applyElo(winnerId, loserId, draw)` actualiza `users` e inserta en `matches`.

| Endpoint | Auth | Función |
|----------|------|---------|
| `POST /api/auth/register` | no | `{username, password}` → `{token, user}`; username 3-16 chars `[a-zA-Z0-9_]`, pass ≥6 |
| `POST /api/auth/login` | no | `{username, password}` → `{token, user}` |
| `GET /api/auth/me` | sí | perfil actual |
| `GET /api/ranking?limit=50` | no | leaderboard por elo desc |
| `GET /api/profile/:username` | no | stats + últimas 10 partidas |
| `GET /api/friends` | sí | `{friends, pendingIn, pendingOut}` con presencia |
| `POST /api/friends/request` | sí | `{username}` → crea solicitud |
| `POST /api/friends/accept` | sí | `{friendId}` → acepta solicitud entrante |

### Cache en memoria
`activeRooms` (Map, `server.js:184-198`) guarda `{ room, players, code, themeMap, themesBySocket }`.
- `themeMap = { GOLD: índiceTema, BLACK: índiceTema }` — colores elegidos por cada jugador
- `themesBySocket = { [socketId]: índiceTema }` — tema de cada jugador para reconstruir `themeMap` tras el swap de colores de la moneda
- Estado de moneda: `coinState = { callerSocketId }` y `coinWinnerSocketId` (se limpian en `disconnect`)
- `loadRoomToCache()` preserva `themeMap` y `themesBySocket` existentes
- `-1` como índice de tema = forzar color default (blanco/negro según modo claro/oscuro)

## Handlers Socket.IO (server.js)

| Evento | Función | Notas |
|--------|---------|-------|
| `create_room` | recibe `{playerName, p1Color}` | crea sala, asigna GOLD, guarda themeMap |
| `join_room` | recibe `{code, name, p1Color}` | asigna BLACK; si nombre existe con `connected===0` → reconexión; `connected===1` → error "Nombre ya en uso"; si colores iguales → BLACK=-1 |
| `reconnect_room` | `{code, name}` | devuelve estado completo: players, turn, board_state, gold/black_time, lastMove, moves, chat, themeMap |
| `make_move` | data con board_state, next_turn, capturas, tiempos | persiste board + tiempos en DB, emite `opponent_move` |
| `coin_flip` | | elige llamador al azar entre conectados, emite `coin_call` |
| `coin_call` | `{call: 'cara'\|'sello'}` | lanza moneda, emite `coin_result` con ganador |
| `coin_choice` | `{start: bool}` | el ganador decide quién es GOLD, actualiza colores + themeMap, emite `game_start` |
| `resign` / `draw_offer` / `draw_response` | | fin de partida / tablas |
| `game_end` | `{result, reason}` | el cliente reporta fin por captura o tiempo (`result`: WIN/LOSS desde su perspectiva); el server determina color ganador |
| `disconnect` | | marca offline, limpia estado de moneda (emite `coin_cancel`), elimina sala si nadie conectado tras 5 min |

### Elo al terminar partidas (server)
- `players.user_id` se linkea al crear/entrar/reconectar sala (vía `socket.userId` del token JWT)
- `endGameWithResult(code, winnerColor, reason)` (`server.js`): marca sala `finished`, y si **ambos** jugadores tienen `user_id` aplica Elo (draw si `winnerColor` null). Emite `game_end {winner, reason}` a todos en la sala (guard `room.status==='finished'` evita doble aplicación)
- El cliente termina así:
  - **Resign**: `socket.emit('resign')` → server emite `game_end` (ya no existe `opponent_resigned`)
  - **Tablas**: el aceptador emite `draw_response,true` → server emite `game_end {winner:null}`
  - **Captura/sin movimientos**: el ganador emite `game_end {result:'WIN'}`
  - **Tiempo**: el cliente cuyo reloj llega a 0 emite `game_end` con `result` según su color (loserColor === myOnlineColor ? 'LOSS' : 'WIN')
- Cliente: handler único `game_end` — guarda `if(gameOver) return` (el ganador local ya cerró), muestra toast según `winner` vs `myOnlineColor`, y llama `refreshAuthUser()` (re-fetch `/api/auth/me` → `setAuthUI()` actualiza header + sidebar con el nuevo ELO)

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

### Lanzamiento de moneda (online)
- Al unirse el oponente, `btnStartOnline` = "Lanzar moneda 🪙" (tanto host como joiner pueden lanzar)
- `coin_call`: el llamador ve botones Cara/Sello (`coinPickRow`); el rival ve "Esperando que X elija..."
- `coin_result`: el ganador ve "Iniciar" / "Rival inicia" (`coinWinnerRow`); asigna colores vía `coin_choice {start}`
- `game_start` recalcula `p1Color`/`p2Color` desde `data.themeMap` según `myOnlineColor` (patrón del reconnect)
- Desconexión durante la moneda → servidor emite `coin_cancel` y se vuelve al botón de lanzar
- `themesBySocket` en cache guarda el tema de cada jugador para reconstruir `themeMap` tras el swap de colores

### Reconexión online
- Botón "Reconectar" en el menú (código + nombre)
- Cliente restaura: board_state, turn, lastMove, gold/black_time, chat, themeMap, roomBadge
- Si `res.moves` está vacío → la partida no empezó: vuelve a la fase de moneda en vez de iniciar
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
