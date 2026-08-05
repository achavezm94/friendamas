const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'friendamas-dev-secret';

const IS_RENDER = !!process.env.RENDER;
if (!IS_RENDER) {
  app.use(express.static(path.join(__dirname, '..', 'front')));
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'front', 'damas.html'));
  });
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['http://localhost:3001', 'https://friendamas.vercel.app', 'http://localhost:5500', 'http://127.0.0.1:5500', 'null', '*'], methods: ['GET', 'POST'], credentials: true }
});

// ─── Database adapter ───
const DATABASE_URL = process.env.DATABASE_URL;
let db;

const SQL = {
  CREATE_TABLES: `
    CREATE TABLE IF NOT EXISTS rooms (
      id ${DATABASE_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      code TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'waiting',
      turn TEXT DEFAULT 'GOLD',
      board_state TEXT,
      gold_captured TEXT DEFAULT '[]',
      black_captured TEXT DEFAULT '[]',
      gold_time INTEGER DEFAULT 300,
      black_time INTEGER DEFAULT 300,
      created_at ${DATABASE_URL ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'}
    );
    CREATE TABLE IF NOT EXISTS players (
      id ${DATABASE_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      room_id INTEGER NOT NULL,
      socket_id TEXT,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      connected INTEGER DEFAULT 1${DATABASE_URL ? '' : ', FOREIGN KEY (room_id) REFERENCES rooms(id)'}
    );
    CREATE TABLE IF NOT EXISTS moves (
      id ${DATABASE_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      room_id INTEGER NOT NULL,
      player_color TEXT NOT NULL,
      from_row INTEGER, from_col INTEGER,
      to_row INTEGER, to_col INTEGER,
      captures TEXT,
      created_at ${DATABASE_URL ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'}
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id ${DATABASE_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      room_id INTEGER NOT NULL,
      player_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at ${DATABASE_URL ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'}
    );
    CREATE TABLE IF NOT EXISTS users (
      id ${DATABASE_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      elo INTEGER DEFAULT 1200,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      online INTEGER DEFAULT 0,
      created_at ${DATABASE_URL ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'}
    );
    CREATE TABLE IF NOT EXISTS matches (
      id ${DATABASE_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      user_id INTEGER NOT NULL,
      opponent_id INTEGER,
      result TEXT NOT NULL,
      rated INTEGER DEFAULT 1,
      elo_change INTEGER DEFAULT 0,
      created_at ${DATABASE_URL ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'}
    );
    CREATE TABLE IF NOT EXISTS friends (
      id ${DATABASE_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      action_user INTEGER NOT NULL,
      created_at ${DATABASE_URL ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP'}
    );
  `
};

async function dbInit() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } else {
    const Database = require('better-sqlite3');
    db = new Database(path.join(__dirname, 'game.db'));
    db.pragma('journal_mode = WAL');
  }
  await dbExec(SQL.CREATE_TABLES);
  await dbExec(`ALTER TABLE players ADD COLUMN user_id INTEGER`).catch(() => {});
  console.log(`Database: ${DATABASE_URL ? `PostgreSQL (${DATABASE_URL.split('@')[1]?.split('/')[0] || 'remote'})` : 'SQLite (local)'}`);
}

function dbSql(sql) {
  return DATABASE_URL ? sql : sql.replace(/\$\d+/g, '?');
}

async function dbExec(sql) {
  if (DATABASE_URL) {
    await db.query(sql);
  } else {
    db.exec(sql);
  }
}

async function dbGet(sql, params = []) {
  sql = dbSql(sql);
  if (DATABASE_URL) {
    const result = await db.query(sql, params);
    return result.rows[0] || null;
  } else {
    return db.prepare(sql).get(...params) || null;
  }
}

async function dbAll(sql, params = []) {
  sql = dbSql(sql);
  if (DATABASE_URL) {
    const result = await db.query(sql, params);
    return result.rows;
  } else {
    return db.prepare(sql).all(...params);
  }
}

async function dbRun(sql, params = []) {
  sql = dbSql(sql);
  if (DATABASE_URL) {
    const result = await db.query(sql, params);
    return { lastInsertRowid: result.rows[0]?.id || 0 };
  } else {
    const stmt = db.prepare(sql);
    return stmt.run(...params);
  }
}

// ─── Queries ───
async function createRoom(code) {
  const row = await dbGet('INSERT INTO rooms (code) VALUES ($1) RETURNING id', [code]);
  return row.id;
}

async function getRoom(code) {
  return dbGet('SELECT * FROM rooms WHERE code = $1', [code]);
}

async function updateRoomStatus(code, status) {
  return dbRun('UPDATE rooms SET status = $1 WHERE code = $2', [status, code]);
}

async function updateRoomBoard(code, board_state, turn, gold_captured, black_captured, gold_time, black_time) {
  return dbRun('UPDATE rooms SET board_state = $1, turn = $2, gold_captured = $3, black_captured = $4, gold_time = $5, black_time = $6 WHERE code = $7',
    [board_state, turn, gold_captured, black_captured, gold_time ?? 300, black_time ?? 300, code]);
}

async function deleteRoomByCode(code) {
  return dbRun('DELETE FROM rooms WHERE code = $1', [code]);
}

async function insertPlayer(roomId, socketId, name, color) {
  return dbRun('INSERT INTO players (room_id, socket_id, name, color, connected) VALUES ($1, $2, $3, $4, 1)',
    [roomId, socketId, name, color]);
}

async function getPlayers(roomId) {
  return dbAll('SELECT * FROM players WHERE room_id = $1', [roomId]);
}

async function findPlayer(code, name) {
  return dbGet('SELECT p.*, r.id as rid FROM players p JOIN rooms r ON p.room_id = r.id WHERE r.code = $1 AND p.name = $2',
    [code, name]);
}

async function updatePlayerSocket(socketId, playerId) {
  return dbRun('UPDATE players SET socket_id = $1, connected = 1 WHERE id = $2', [socketId, playerId]);
}

async function setPlayerOffline(socketId) {
  return dbRun('UPDATE players SET socket_id = NULL, connected = 0 WHERE socket_id = $1', [socketId]);
}

async function updatePlayerColor(playerId, color) {
  return dbRun('UPDATE players SET color = $1 WHERE id = $2', [color, playerId]);
}

async function insertMove(roomId, playerColor, fromRow, fromCol, toRow, toCol, captures) {
  return dbRun('INSERT INTO moves (room_id, player_color, from_row, from_col, to_row, to_col, captures) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [roomId, playerColor, fromRow, fromCol, toRow, toCol, captures]);
}

async function getMoves(roomId) {
  return dbAll('SELECT * FROM moves WHERE room_id = $1 ORDER BY id', [roomId]);
}

async function insertChat(roomId, playerName, text) {
  return dbRun('INSERT INTO chat_messages (room_id, player_name, text) VALUES ($1, $2, $3)', [roomId, playerName, text]);
}

async function getChat(roomId) {
  return dbAll('SELECT * FROM chat_messages WHERE room_id = $1 ORDER BY id LIMIT 50', [roomId]);
}

// ─── Auth ───
function signToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function publicUser(u) {
  return { id: u.id, username: u.username, elo: u.elo, wins: u.wins, losses: u.losses, draws: u.draws, online: u.online };
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'No autorizado' });
  req.userId = payload.id;
  next();
}

// ─── User queries ───
async function findUserByUsername(username) {
  return dbGet('SELECT * FROM users WHERE username = $1', [username]);
}

async function findUserById(id) {
  return dbGet('SELECT * FROM users WHERE id = $1', [id]);
}

async function createUser(username, passwordHash) {
  return dbGet('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [username, passwordHash]);
}

async function updateUserStats(userId, result, elo) {
  if (result === 'WIN') return dbRun('UPDATE users SET elo = $1, wins = wins + 1 WHERE id = $2', [elo, userId]);
  if (result === 'LOSS') return dbRun('UPDATE users SET elo = $1, losses = losses + 1 WHERE id = $2', [elo, userId]);
  return dbRun('UPDATE users SET elo = $1, draws = draws + 1 WHERE id = $2', [elo, userId]);
}

async function insertMatch(userId, opponentId, result, eloChange) {
  return dbRun('INSERT INTO matches (user_id, opponent_id, result, rated, elo_change) VALUES ($1, $2, $3, 1, $4)',
    [userId, opponentId, result, eloChange]);
}

async function getRanking(limit) {
  return dbAll('SELECT id, username, elo, wins, losses, draws FROM users ORDER BY elo DESC LIMIT $1', [limit || 50]);
}

async function getFriendRelations(userId) {
  const mine = await dbAll('SELECT id, user_id, friend_id, status, action_user FROM friends WHERE user_id = $1', [userId]);
  const theirs = await dbAll('SELECT id, user_id, friend_id, status, action_user FROM friends WHERE friend_id = $1', [userId]);
  const rels = [];
  for (const f of mine) rels.push({ frid: f.id, status: f.status, action_user: f.action_user, uid: f.friend_id });
  for (const f of theirs) rels.push({ frid: f.id, status: f.status, action_user: f.action_user, uid: f.user_id });
  const uids = [...new Set(rels.map(r => r.uid))];
  const byId = {};
  if (uids.length) {
    const placeholders = uids.map((_, i) => `$${i + 1}`).join(',');
    const users = await dbAll(`SELECT id, username, elo, online FROM users WHERE id IN (${placeholders})`, uids);
    for (const u of users) byId[u.id] = u;
  }
  return rels.map(r => ({ ...r, username: byId[r.uid]?.username, elo: byId[r.uid]?.elo, online: byId[r.uid]?.online }));
}

// ─── Elo ───
function eloExpectation(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

const ELO_K = 32;

async function applyElo(winnerId, loserId, draw) {
  if (!winnerId || !loserId) return;
  const winner = await findUserById(winnerId);
  const loser = await findUserById(loserId);
  if (!winner || !loser) return;
  if (draw) {
    const eW = eloExpectation(winner.elo, loser.elo);
    const eL = eloExpectation(loser.elo, winner.elo);
    const deltaW = Math.round(ELO_K * (0.5 - eW));
    const deltaL = Math.round(ELO_K * (0.5 - eL));
    const newW = Math.max(100, winner.elo + deltaW);
    const newL = Math.max(100, loser.elo + deltaL);
    await updateUserStats(winnerId, 'DRAW', newW);
    await updateUserStats(loserId, 'DRAW', newL);
    await insertMatch(winnerId, loserId, 'DRAW', newW - winner.elo);
    await insertMatch(loserId, winnerId, 'DRAW', newL - loser.elo);
    return;
  }
  const eW = eloExpectation(winner.elo, loser.elo);
  const eL = eloExpectation(loser.elo, winner.elo);
  const deltaW = Math.round(ELO_K * (1 - eW));
  const deltaL = Math.round(ELO_K * (0 - eL));
  const newW = Math.max(100, winner.elo + deltaW);
  const newL = Math.max(100, loser.elo + deltaL);
  await updateUserStats(winnerId, 'WIN', newW);
  await updateUserStats(loserId, 'LOSS', newL);
  await insertMatch(winnerId, loserId, 'WIN', newW - winner.elo);
  await insertMatch(loserId, winnerId, 'LOSS', newL - loser.elo);
}

// ─── In-memory cache ───
const activeRooms = new Map();
const userSocketCounts = new Map();

async function loadRoomToCache(code) {
  const room = await getRoom(code);
  if (!room) return null;
  const players = await getPlayers(room.id);
  const existing = activeRooms.get(code) || {};
  const entry = { room, players, code, themeMap: existing.themeMap || {}, themesBySocket: existing.themesBySocket || {} };
  activeRooms.set(code, entry);
  return entry;
}

function getRoomData(code) {
  if (activeRooms.has(code)) return activeRooms.get(code);
  return null;
}

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ─── Socket.io ───
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (token) {
      const payload = verifyToken(token);
      if (payload) socket.userId = payload.id;
    }
  } catch (e) { /* invitados siguen adelante */ }
  next();
});

io.on('connection', async (socket) => {
  console.log('Conectado:', socket.id, socket.userId ? `(user ${socket.userId})` : '(guest)');
  if (socket.userId) {
    userSocketCounts.set(socket.userId, (userSocketCounts.get(socket.userId) || 0) + 1);
    await dbRun('UPDATE users SET online = 1 WHERE id = $1', [socket.userId]);
  }

  socket.on('create_room', async ({ playerName, p1Color }, callback) => {
    let code;
    do { code = generateCode(); } while (await getRoom(code));
    const roomId = await createRoom(code);
    await insertPlayer(roomId, socket.id, playerName, 'GOLD');
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName;
    const room = await getRoom(code);
    const players = await getPlayers(roomId);
    activeRooms.set(code, { room, players, code, themeMap: { GOLD: p1Color }, themesBySocket: { [socket.id]: p1Color } });
    callback({ code, p2Color: null });
    console.log(`Sala ${code} creada por ${playerName}`);
  });

  socket.on('join_room', async ({ code, name, p1Color }, callback) => {
    const room = await getRoom(code);
    if (!room) return callback({ error: 'Sala no encontrada' });
    const players = await getPlayers(room.id);
    if (players.length >= 2) return callback({ error: 'Sala llena' });

    const existing = await findPlayer(code, name);
    if (existing && existing.connected === 0) {
      await updatePlayerSocket(socket.id, existing.id);
      socket.join(code);
      socket.roomCode = code;
      socket.playerName = name;
      const entry = await loadRoomToCache(code);
      const rd = getRoomData(code);
      callback({ success: true, players: entry.players, turn: entry.room.turn, board_state: entry.room.board_state, gold_captured: entry.room.gold_captured, black_captured: entry.room.black_captured, reconnected: true, themeMap: rd?.themeMap || {} });
      socket.to(code).emit('opponent_reconnected', { themeMap: rd?.themeMap || {} });
      return;
    }
    if (existing && existing.connected === 1) {
      return callback({ error: 'Nombre ya en uso en esta sala' });
    }

    let joinerTheme = p1Color;
    const rd = getRoomData(code);
    if (rd && rd.themeMap && rd.themeMap.GOLD === joinerTheme) {
      joinerTheme = -1;
    }
    await insertPlayer(room.id, socket.id, name, 'BLACK');
    await updateRoomStatus(code, 'playing');
    const updatedPlayers = await getPlayers(room.id);
    const entry = await loadRoomToCache(code);
    const roomData = getRoomData(code);
    if (roomData) { roomData.themeMap = roomData.themeMap || {}; roomData.themeMap.BLACK = joinerTheme; roomData.themeMap.GOLD = roomData.themeMap.GOLD ?? 0; roomData.themesBySocket = roomData.themesBySocket || {}; roomData.themesBySocket[socket.id] = joinerTheme; activeRooms.set(code, roomData); }
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    callback({ success: true, players: updatedPlayers, turn: 'GOLD', themeMap: { GOLD: roomData?.themeMap?.GOLD ?? 0, BLACK: joinerTheme } });
    console.log(`[join_room] updatedPlayers:`, JSON.stringify(updatedPlayers));
    socket.to(code).emit('opponent_joined', { name, players: updatedPlayers, turn: 'GOLD', themeMap: { GOLD: roomData?.themeMap?.GOLD ?? 0, BLACK: joinerTheme } });
    console.log(`${name} se unió a sala ${code}`);
  });

  socket.on('reconnect_room', async ({ code, name }, callback) => {
    const existing = await findPlayer(code, name);
    if (!existing) return callback({ error: 'No se encontró la sala o el nombre' });
    await updatePlayerSocket(socket.id, existing.id);
    const entry = await loadRoomToCache(code);
    if (!entry) return callback({ error: 'Error al cargar sala' });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    const moves = await getMoves(entry.room.id);
    const chat = await getChat(entry.room.id);
    const rd = getRoomData(code);
    const lastMoveData = moves.length ? moves[moves.length - 1] : null;
    callback({ success: true, players: entry.players, turn: entry.room.turn, board_state: entry.room.board_state, gold_captured: entry.room.gold_captured, black_captured: entry.room.black_captured, gold_time: entry.room.gold_time, black_time: entry.room.black_time, moves, chat, themeMap: rd?.themeMap || {}, lastMove: lastMoveData ? { from: { r: lastMoveData.from_row, c: lastMoveData.from_col }, to: { r: lastMoveData.to_row, c: lastMoveData.to_col } } : null });
    console.log(`${name} reconectado a sala ${code}`);
  });

  socket.on('make_move', async (data) => {
    const code = socket.roomCode;
    if (!code) return;
    const roomData = activeRooms.get(code);
    if (!roomData) return;
    const player = roomData.players.find(p => p.socket_id === socket.id);
    if (!player) return;
    await insertMove(roomData.room.id, player.color, data.fromRow, data.fromCol, data.toRow, data.toCol, JSON.stringify(data.captures || []));
    if (data.board_state) {
      roomData.room.board_state = data.board_state;
      roomData.room.turn = data.next_turn;
      roomData.room.gold_captured = data.gold_captured || roomData.room.gold_captured;
      roomData.room.black_captured = data.black_captured || roomData.room.black_captured;
      roomData.room.gold_time = data.gold_time ?? roomData.room.gold_time;
      roomData.room.black_time = data.black_time ?? roomData.room.black_time;
      await updateRoomBoard(code, roomData.room.board_state, roomData.room.turn, roomData.room.gold_captured, roomData.room.black_captured, roomData.room.gold_time, roomData.room.black_time);
    }
    socket.to(code).emit('opponent_move', data);
  });

  socket.on('chat_message', async (text) => {
    const code = socket.roomCode;
    if (!code) return;
    const roomData = activeRooms.get(code);
    if (!roomData) return;
    await insertChat(roomData.room.id, socket.playerName || 'Unknown', text);
    socket.to(code).emit('chat_message', { from: socket.playerName || 'Unknown', text });
  });

  socket.on('resign', async () => {
    const code = socket.roomCode;
    if (!code) return;
    await updateRoomStatus(code, 'finished');
    io.to(code).emit('opponent_resigned');
  });

  socket.on('draw_offer', () => {
    const code = socket.roomCode;
    if (!code) return;
    socket.to(code).emit('draw_offer');
  });

  socket.on('draw_response', async (accept) => {
    const code = socket.roomCode;
    if (!code) return;
    if (accept) await updateRoomStatus(code, 'finished');
    io.to(code).emit('draw_response', { accept });
  });

  socket.on('coin_flip', () => {
    const code = socket.roomCode;
    if (!code) return;
    const roomData = activeRooms.get(code);
    if (!roomData || roomData.coinState || roomData.coinWinnerSocketId) return;
    const connected = roomData.players.filter(p => p.connected);
    if (connected.length < 2) return;
    const caller = connected[Math.floor(Math.random() * connected.length)];
    roomData.coinState = { callerSocketId: caller.socket_id };
    io.to(code).emit('coin_call', { callerSocketId: caller.socket_id, callerName: caller.name });
  });

  socket.on('coin_call', ({ call }) => {
    const code = socket.roomCode;
    if (!code) return;
    const roomData = activeRooms.get(code);
    if (!roomData || !roomData.coinState) return;
    if (roomData.coinState.callerSocketId !== socket.id) return;
    const caller = roomData.players.find(p => p.socket_id === socket.id);
    const other = roomData.players.find(p => p.socket_id !== socket.id);
    if (!caller || !other) return;
    const result = Math.random() < 0.5 ? 'cara' : 'sello';
    const winner = call === result ? caller : other;
    roomData.coinState = null;
    roomData.coinWinnerSocketId = winner.socket_id;
    io.to(code).emit('coin_result', { result, winnerSocketId: winner.socket_id, winnerName: winner.name });
  });

  socket.on('coin_choice', async ({ start }) => {
    const code = socket.roomCode;
    if (!code) return;
    const roomData = activeRooms.get(code);
    if (!roomData || roomData.coinWinnerSocketId !== socket.id) return;
    const winner = roomData.players.find(p => p.socket_id === socket.id);
    const other = roomData.players.find(p => p.socket_id !== socket.id);
    if (!winner || !other) return;
    const goldP = start ? winner : other;
    const blackP = start ? other : winner;
    await updatePlayerColor(goldP.id, 'GOLD');
    await updatePlayerColor(blackP.id, 'BLACK');
    goldP.color = 'GOLD'; blackP.color = 'BLACK';
    if (roomData.themesBySocket && roomData.themeMap) {
      roomData.themeMap.GOLD = roomData.themesBySocket[goldP.socket_id] ?? 0;
      roomData.themeMap.BLACK = roomData.themesBySocket[blackP.socket_id] ?? -1;
    }
    roomData.coinWinnerSocketId = null;
    roomData.coinState = null;
    await updateRoomStatus(code, 'playing');
    io.to(code).emit('game_start', { players: roomData.players, turn: 'GOLD', themeMap: roomData.themeMap || {} });
  });

  socket.on('disconnect', async () => {
    const code = socket.roomCode;
    console.log('Desconectado:', socket.id, 'Sala:', code);
    if (socket.userId) {
      const count = (userSocketCounts.get(socket.userId) || 1) - 1;
      if (count <= 0) {
        userSocketCounts.delete(socket.userId);
        await dbRun('UPDATE users SET online = 0 WHERE id = $1', [socket.userId]);
      } else {
        userSocketCounts.set(socket.userId, count);
      }
    }
    if (code) {
      await setPlayerOffline(socket.id);
      const roomData = activeRooms.get(code);
      if (roomData) {
        const player = roomData.players.find(p => p.socket_id === socket.id);
        if (player) player.connected = 0;
        if (roomData.coinState && roomData.coinState.callerSocketId === socket.id) { roomData.coinState = null; io.to(code).emit('coin_cancel'); }
        if (roomData.coinWinnerSocketId === socket.id) { roomData.coinWinnerSocketId = null; io.to(code).emit('coin_cancel'); }
        const anyConnected = roomData.players.some(p => p.connected);
        if (!anyConnected) {
          setTimeout(async () => {
            const still = activeRooms.get(code);
            if (still && !still.players.some(p => p.connected)) {
              activeRooms.delete(code);
              await deleteRoomByCode(code);
              console.log(`Sala ${code} eliminada por inactividad`);
            }
          }, 300000);
        }
      }
      socket.to(code).emit('opponent_disconnected');
    }
  });
});

// ─── REST API ───
app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (username.length < 3 || username.length > 16) return res.status(400).json({ error: 'El usuario debe tener entre 3 y 16 caracteres' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Solo letras, números y guion bajo' });
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const existing = await findUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'El nombre de usuario ya está en uso' });
    const hash = await hashPassword(password);
    const created = await createUser(username, hash);
    const user = await findUserById(created.id);
    const token = signToken(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'Error al registrar' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = await findUserByUsername(username);
    if (!user || !(await checkPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const token = signToken(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: publicUser(user) });
});

app.get('/api/ranking', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const rows = await getRanking(limit);
    res.json({ ranking: rows.map((r, i) => ({ rank: i + 1, ...r })) });
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener ranking' });
  }
});

app.get('/api/profile/:username', async (req, res) => {
  try {
    const user = await findUserByUsername(req.params.username);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const recent = await dbAll('SELECT * FROM matches WHERE user_id = $1 ORDER BY id DESC LIMIT 10', [user.id]);
    res.json({ user: publicUser(user), recent });
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

app.get('/api/friends', requireAuth, async (req, res) => {
  const relations = await getFriendRelations(req.userId);
  const active = relations.filter(r => r.status === 'active').map(r => ({ id: r.uid, username: r.username, elo: r.elo, online: r.online }));
  const pendingOut = relations.filter(r => r.status === 'pending' && r.action_user === req.userId).map(r => r.uid);
  const pendingIn = relations.filter(r => r.status === 'pending' && r.action_user !== req.userId).map(r => ({ id: r.uid, username: r.username, elo: r.elo, online: r.online }));
  res.json({ friends: active, pendingIn, pendingOut });
});

app.post('/api/friends/request', requireAuth, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const target = await findUserByUsername(username);
  if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (target.id === req.userId) return res.status(400).json({ error: 'No puedes agregarte a ti mismo' });
  const relations = await getFriendRelations(req.userId);
  const exists = relations.find(r => r.uid === target.id);
  if (exists) {
    if (exists.status === 'active') return res.status(409).json({ error: 'Ya son amigos' });
    return res.status(409).json({ error: 'La solicitud ya existe' });
  }
  await dbRun('INSERT INTO friends (user_id, friend_id, status, action_user) VALUES ($1, $2, \'pending\', $3)', [req.userId, target.id, req.userId]);
  res.json({ ok: true });
});

app.post('/api/friends/accept', requireAuth, async (req, res) => {
  const friendId = parseInt(req.body.friendId);
  const result = await dbRun('UPDATE friends SET status = \'active\' WHERE status = \'pending\' AND action_user = $1 AND friend_id = $2', [friendId, req.userId]);
  if (DATABASE_URL) {
    if (!result.rowCount) return res.status(404).json({ error: 'Solicitud no encontrada' });
  } else {
    if (result.changes === 0) return res.status(404).json({ error: 'Solicitud no encontrada' });
  }
  res.json({ ok: true });
});

// ─── Start ───
const PORT = process.env.PORT || 3001;
dbInit().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`FrienDamas Server v2 corriendo en puerto ${PORT}`);
  });
}).catch(err => {
  console.error('Error al iniciar DB:', err);
  process.exit(1);
});
