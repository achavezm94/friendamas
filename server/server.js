const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'front')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'front', 'damas.html'));
});

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

async function updateRoomBoard(code, board_state, turn, gold_captured, black_captured) {
  return dbRun('UPDATE rooms SET board_state = $1, turn = $2, gold_captured = $3, black_captured = $4 WHERE code = $5',
    [board_state, turn, gold_captured, black_captured, code]);
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

// ─── In-memory cache ───
const activeRooms = new Map();

async function loadRoomToCache(code) {
  const room = await getRoom(code);
  if (!room) return null;
  const players = await getPlayers(room.id);
  const existing = activeRooms.get(code) || {};
  const entry = { room, players, code, themeMap: existing.themeMap || {} };
  activeRooms.set(code, entry);
  return entry;
}

function getRoomData(code) {
  if (activeRooms.has(code)) return activeRooms.get(code);
  return null;
}

const THEME_COUNT = 4;

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ─── Socket.io ───
io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

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
    activeRooms.set(code, { room, players, code, themeMap: { GOLD: p1Color } });
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
      const used = [rd.themeMap.GOLD];
      const available = Array.from({length: THEME_COUNT}, (_, i) => i).filter(i => !used.includes(i));
      joinerTheme = available.length ? available[Math.floor(Math.random() * available.length)] : 0;
    }
    await insertPlayer(room.id, socket.id, name, 'BLACK');
    await updateRoomStatus(code, 'playing');
    const updatedPlayers = await getPlayers(room.id);
    const entry = await loadRoomToCache(code);
    const roomData = getRoomData(code);
    if (roomData) { roomData.themeMap = roomData.themeMap || {}; roomData.themeMap.BLACK = joinerTheme; roomData.themeMap.GOLD = roomData.themeMap.GOLD ?? 0; activeRooms.set(code, roomData); }
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
    callback({ success: true, players: entry.players, turn: entry.room.turn, board_state: entry.room.board_state, gold_captured: entry.room.gold_captured, black_captured: entry.room.black_captured, moves, chat, themeMap: rd?.themeMap || {} });
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
      await updateRoomBoard(code, roomData.room.board_state, roomData.room.turn, roomData.room.gold_captured, roomData.room.black_captured);
    }
    socket.to(code).emit('opponent_move', data);
  });

  socket.on('chat_message', async (text) => {
    const code = socket.roomCode;
    if (!code) return;
    const roomData = activeRooms.get(code);
    if (!roomData) return;
    await insertChat(roomData.room.id, socket.playerName || 'Unknown', text);
    io.to(code).emit('chat_message', { from: socket.playerName || 'Unknown', text });
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

  socket.on('disconnect', async () => {
    const code = socket.roomCode;
    console.log('Desconectado:', socket.id, 'Sala:', code);
    if (code) {
      await setPlayerOffline(socket.id);
      const roomData = activeRooms.get(code);
      if (roomData) {
        const player = roomData.players.find(p => p.socket_id === socket.id);
        if (player) player.connected = 0;
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
