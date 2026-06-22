/**
 * multiplayer.js
 * Scalable Express & Socket.io Real-Time Multiplayer Communications Hub
 */
const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');

const PORT = 3000;
const app = express();
const server = http.createServer(app);

// Use the universally supported Socket.io instantiation syntax
const io = socketIo(server);

// Serve static assets directly from root directory
app.use(express.static(__dirname));

// Route default path to our interactive 3D view
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'game.html'));
});

/**
 * Version-agnostic helper to safely extract connected sockets across Socket.io v2, v3, and v4
 */
function getConnectedSockets() {
  const namespace = io.of("/");
  if (namespace.sockets instanceof Map) {
    // Socket.io v3 & v4 (ES6 Map)
    return Array.from(namespace.sockets.values());
  } else if (namespace.sockets && typeof namespace.sockets === 'object') {
    // Socket.io v2 (Standard Object dictionary)
    return Object.values(namespace.sockets);
  }
  if (namespace.connected && typeof namespace.connected === 'object') {
    // Legacy fallback
    return Object.values(namespace.connected);
  }
  return [];
}

// Socket.io Real-Time Pipeline
io.on('connection', (socket) => {
  console.log('Astronaut linked via Socket.io secure connection.');

  socket.on('join', (data) => {
    // Store profile state directly inside the session socket context
    socket.playerProfile = {
      id: data.id,
      username: data.username,
      color: data.color,
      position: data.position,
      rotation: data.rotation,
      completedTasks: [] // Tracks active tasks completed during this session
    };

    console.log(`Astronaut registered: ID ${data.id} (${data.username})`);

    // Broadcast join signature to other crewmates
    socket.broadcast.emit('player_joined', socket.playerProfile);

    // Version-agnostic lookup of other active players
    const activeLobby = [];
    const connectedSockets = getConnectedSockets();
    
    connectedSockets.forEach((s) => {
      if (s.id !== socket.id && s.playerProfile) {
        activeLobby.push(s.playerProfile);
      }
    });

    socket.emit('initial_state', { players: activeLobby });
  });

  socket.on('move', (data) => {
    if (socket.playerProfile) {
      socket.playerProfile.position = data.position;
      socket.playerProfile.rotation = data.rotation;

      socket.broadcast.emit('player_moved', {
        id: socket.playerProfile.id,
        position: data.position,
        rotation: data.rotation
      });
    }
  });

  // Track task completions dynamically on the server
  socket.on('task_complete', (data) => {
    if (socket.playerProfile) {
      socket.playerProfile.completedTasks.push(data.taskName);
      console.log(`Task verified on server: [${data.taskName}] completed by ${data.username}`);

      // Broadcast verified completion update to all other connected players
      io.emit('task_broadcast', {
        id: socket.playerProfile.id,
        username: data.username,
        taskName: data.taskName
      });
    }
  });

  socket.on('disconnect', () => {
    if (socket.playerProfile) {
      console.log(`Astronaut departed: ${socket.playerProfile.id}`);
      socket.broadcast.emit('player_left', { id: socket.playerProfile.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  SKELD SYSTEM ACTIVE: http://localhost:${PORT}/`);
  console.log(`======================================================\n`);
});