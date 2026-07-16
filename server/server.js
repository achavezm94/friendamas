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

const rooms = {};

io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  socket.on('create_room', (playerName, callback) => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[code] = {
      players: [{ id: socket.id, name: playerName, color: 'GOLD' }],
      turn: 'GOLD'
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName;
    callback({ code });
    console.log(`Sala ${code} creada por ${playerName}`);
  });

  socket.on('join_room', ({ code, name }, callback) => {
    const room = rooms[code];
    if (!room) return callback({ error: 'Sala no encontrada' });
    if (room.players.length >= 2) return callback({ error: 'Sala llena' });
    room.players.push({ id: socket.id, name, color: 'BLACK' });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    callback({ success: true, players: room.players, turn: 'GOLD' });
    socket.to(code).emit('opponent_joined', {
      name,
      players: room.players,
      turn: 'GOLD'
    });
    console.log(`${name} se unió a sala ${code}`);
  });

  socket.on('make_move', (data) => {
    const code = socket.roomCode;
    if (!code) return;
    socket.to(code).emit('opponent_move', data);
  });

  socket.on('chat_message', (text) => {
    const code = socket.roomCode;
    if (!code) return;
    io.to(code).emit('chat_message', {
      from: socket.playerName || 'Unknown',
      text
    });
  });

  socket.on('resign', () => {
    const code = socket.roomCode;
    if (!code) return;
    io.to(code).emit('opponent_resigned');
  });

  socket.on('draw_offer', () => {
    const code = socket.roomCode;
    if (!code) return;
    socket.to(code).emit('draw_offer');
  });

  socket.on('draw_response', (accept) => {
    const code = socket.roomCode;
    if (!code) return;
    io.to(code).emit('draw_response', { accept });
  });

  socket.on('timer_sync', (data) => {
    const code = socket.roomCode;
    if (!code) return;
    socket.to(code).emit('timer_sync', data);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    console.log('Desconectado:', socket.id);
    if (code && rooms[code]) {
      io.to(code).emit('opponent_disconnected');
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`FrienDamas Server corriendo en puerto ${PORT}`);
});
