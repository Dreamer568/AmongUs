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

// Load task sets on startup from task_sets.json
const fs = require('fs');
let taskSets = [];
try {
  const fileData = fs.readFileSync(path.join(__dirname, 'task_sets.json'), 'utf8');
  taskSets = JSON.parse(fileData).task_sets;
  console.log(`Successfully loaded ${taskSets.length} task sets on startup.`);
} catch (err) {
  console.error('CRITICAL: Failed to load task_sets.json:', err);
}

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

/**
 * Room management state mapping room code -> room state object
 */
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getUniqueRoomCode() {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));
  return code;
}

/**
 * Computes global progress percentage for a specific room
 */
function getRoomProgress(room) {
  let totalTasks = 0;
  let completedTasksCount = 0;
  
  room.players.forEach((p) => {
    if (p.assignedTaskSet) {
      totalTasks += p.assignedTaskSet.tasks.length;
      completedTasksCount += p.completedTasks.length;
    }
  });
  
  return totalTasks > 0 ? parseFloat(((completedTasksCount / totalTasks) * 100).toFixed(2)) : 0;
}

// Socket.io Real-Time Pipeline
io.on('connection', (socket) => {
  console.log('Astronaut linked via Socket.io secure connection.');

  // Host creates a room
  socket.on('create_room', (data) => {
    const roomCode = getUniqueRoomCode();
    
    socket.roomCode = roomCode;
    socket.playerProfile = {
      id: socket.id,
      username: data.username || 'Host',
      color: data.color || '#ea580c',
      position: { x: 6.79, y: 5.90, z: -23.93 },
      rotation: 0,
      assignedTaskSet: null,
      completedTasks: [],
      role: 'Crewmate',
      isHost: true
    };

    const room = {
      code: roomCode,
      hostId: socket.id,
      settings: {
        maxPlayers: parseInt(data.settings?.maxPlayers) || 10,
        impostors: parseInt(data.settings?.impostors) || 1,
        allowMidGameJoin: data.settings?.allowMidGameJoin !== false
      },
      players: [socket.playerProfile],
      gameStarted: false
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);

    console.log(`Room created: ${roomCode} by ${socket.playerProfile.username} with settings:`, room.settings);
    
    socket.emit('room_created', {
      roomCode: roomCode,
      roomState: room,
      playerProfile: socket.playerProfile
    });
  });

  // Player joins a room
  socket.on('join_room', (data) => {
    const code = (data.roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join_error', { message: 'Lobby not found.' });
      return;
    }

    if (room.gameStarted && !room.settings.allowMidGameJoin) {
      socket.emit('join_error', { message: 'Game already started.' });
      return;
    }

    if (room.players.length >= room.settings.maxPlayers) {
      socket.emit('join_error', { message: 'Lobby is full.' });
      return;
    }

    // Set up profile
    socket.roomCode = code;
    socket.playerProfile = {
      id: socket.id,
      username: data.username || 'Crewmate',
      color: data.color || '#10b981',
      position: { x: 6.79, y: 5.90, z: -23.93 },
      rotation: 0,
      assignedTaskSet: null,
      completedTasks: [],
      role: 'Crewmate',
      isHost: false
    };

    // If game has already started, assign random task set and standard role
    if (room.gameStarted) {
      if (taskSets.length > 0) {
        socket.playerProfile.assignedTaskSet = taskSets[Math.floor(Math.random() * taskSets.length)];
      }
      // Note: joined mid-game defaults to Crewmate to avoid skewing game balance
      socket.playerProfile.role = 'Crewmate';
    }

    room.players.push(socket.playerProfile);
    socket.join(code);

    console.log(`Player joined room ${code}: ${socket.playerProfile.username}`);

    // Let the joining player know
    socket.emit('room_joined', {
      roomCode: code,
      roomState: room,
      playerProfile: socket.playerProfile
    });

    // Notify other players in the room
    socket.to(code).emit('player_joined', socket.playerProfile);

    // If game started, broadcast new progress since player joined
    if (room.gameStarted) {
      io.to(code).emit('progress_update', {
        progress: getRoomProgress(room)
      });
    }
  });

  // Host starts the game
  socket.on('start_game', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id || room.gameStarted) return;

    // Assign roles: pick Impostors
    let impostorCount = parseInt(room.settings.impostors) || 1;
    if (room.players.length > 1) {
      impostorCount = Math.max(1, Math.min(impostorCount, room.players.length - 1));
    } else {
      impostorCount = 0; // Solo player cannot be impostor (no targets)
    }

    // Shuffle players to assign roles randomly
    const shuffledIndex = Array.from({ length: room.players.length }, (_, i) => i);
    for (let i = shuffledIndex.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledIndex[i], shuffledIndex[j]] = [shuffledIndex[j], shuffledIndex[i]];
    }

    const impostorIndices = new Set(shuffledIndex.slice(0, impostorCount));

    // Assign roles & task sets
    room.players.forEach((p, index) => {
      p.role = impostorIndices.has(index) ? 'Impostor' : 'Crewmate';
      p.completedTasks = [];
      if (taskSets.length > 0) {
        p.assignedTaskSet = taskSets[Math.floor(Math.random() * taskSets.length)];
      }
    });

    room.gameStarted = true;
    console.log(`Game starting in Room ${room.code} with ${impostorCount} impostor(s).`);

    // Retrieve active sockets in this room to emit customized game_started payloads
    const connectedSockets = getConnectedSockets();
    connectedSockets.forEach((s) => {
      if (s.roomCode === room.code && s.playerProfile) {
        const profile = room.players.find(p => p.id === s.id);
        if (profile) {
          // Mask roles: Impostor knows all other Impostors. Crewmate knows nothing.
          const sanitizedPlayers = room.players.map(p => {
            const showRole = profile.role === 'Impostor' && p.role === 'Impostor';
            return {
              id: p.id,
              username: p.username,
              color: p.color,
              position: p.position,
              rotation: p.rotation,
              role: showRole ? 'Impostor' : 'Crewmate',
              isHost: p.isHost
            };
          });

          // Sync local socket profile with role details
          s.playerProfile.role = profile.role;
          s.playerProfile.assignedTaskSet = profile.assignedTaskSet;

          s.emit('game_started', {
            players: sanitizedPlayers,
            localRole: profile.role,
            assignedTaskSet: profile.assignedTaskSet,
            globalProgress: 0
          });
        }
      }
    });
  });

  // Player movement inside a room
  socket.on('move', (data) => {
    if (socket.roomCode && socket.playerProfile) {
      socket.playerProfile.position = data.position;
      socket.playerProfile.rotation = data.rotation;

      socket.to(socket.roomCode).emit('player_moved', {
        id: socket.playerProfile.id,
        position: data.position,
        rotation: data.rotation
      });
    }
  });

  // Track task completions per room
  socket.on('task_complete', (data) => {
    if (socket.roomCode && socket.playerProfile) {
      const room = rooms.get(socket.roomCode);
      if (!room) return;

      const profile = room.players.find(p => p.id === socket.id);
      if (profile) {
        profile.completedTasks.push(data.taskName);
        console.log(`Task verified in Room ${room.code}: [${data.taskName}] completed by ${data.username}`);

        // Broadcast task completion to other players in the room
        io.to(room.code).emit('task_broadcast', {
          id: socket.id,
          username: data.username,
          taskName: data.taskName
        });

        // Broadcast room-specific progress update
        io.to(room.code).emit('progress_update', {
          progress: getRoomProgress(room)
        });
      }
    }
  });

  // Handle manual leave lobby
  socket.on('leave_room', () => {
    if (socket.roomCode) {
      const code = socket.roomCode;
      const room = rooms.get(code);

      socket.leave(code);
      delete socket.roomCode;
      delete socket.playerProfile;

      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        io.to(code).emit('player_left', { id: socket.id });

        // Host migration
        if (room.hostId === socket.id && room.players.length > 0) {
          const newHost = room.players[0];
          room.hostId = newHost.id;
          newHost.isHost = true;
          io.to(code).emit('host_migrated', { hostId: newHost.id });
          console.log(`Room ${code}: Host migrated to ${newHost.username}`);
        }

        if (room.players.length === 0) {
          rooms.delete(code);
          console.log(`Room ${code} deleted (empty).`);
        } else {
          io.to(code).emit('progress_update', {
            progress: getRoomProgress(room)
          });
        }
      }
      socket.emit('left_room');
    }
  });

  // Disconnection handler
  socket.on('disconnect', () => {
    if (socket.roomCode) {
      const code = socket.roomCode;
      const room = rooms.get(code);

      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        socket.to(code).emit('player_left', { id: socket.id });

        // Host migration
        if (room.hostId === socket.id && room.players.length > 0) {
          const newHost = room.players[0];
          room.hostId = newHost.id;
          newHost.isHost = true;
          io.to(code).emit('host_migrated', { hostId: newHost.id });
          console.log(`Room ${code}: Host migrated to ${newHost.username}`);
        }

        if (room.players.length === 0) {
          rooms.delete(code);
          console.log(`Room ${code} deleted (empty).`);
        } else {
          io.to(code).emit('progress_update', {
            progress: getRoomProgress(room)
          });
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  SKELD SYSTEM ACTIVE: http://localhost:${PORT}/`);
  console.log(`======================================================\n`);
});