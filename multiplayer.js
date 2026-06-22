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
 * Computes global progress percentage across all active players
 */
function getGlobalProgress() {
  const connectedSockets = getConnectedSockets();
  let totalTasks = 0;
  let completedTasksCount = 0;
  
  connectedSockets.forEach((s) => {
    if (s.playerProfile && s.playerProfile.assignedTaskSet) {
      totalTasks += s.playerProfile.assignedTaskSet.tasks.length;
      completedTasksCount += s.playerProfile.completedTasks.length;
    }
  });
  
  return totalTasks > 0 ? parseFloat(((completedTasksCount / totalTasks) * 100).toFixed(2)) : 0;
}

// Socket.io Real-Time Pipeline
io.on('connection', (socket) => {
  console.log('Astronaut linked via Socket.io secure connection.');

  socket.on('join', (data) => {
    // Assign a random task set to the joining player if any are loaded
    let chosenTaskSet = null;
    if (taskSets.length > 0) {
      chosenTaskSet = taskSets[Math.floor(Math.random() * taskSets.length)];
    }

    // Store profile state directly inside the session socket context
    socket.playerProfile = {
      id: data.id,
      username: data.username,
      color: data.color,
      position: data.position,
      rotation: data.rotation,
      assignedTaskSet: chosenTaskSet,
      completedTasks: [] // Tracks active tasks completed during this session
    };

    console.log(`Astronaut registered: ID ${data.id} (${data.username}) with task set: ${chosenTaskSet ? chosenTaskSet.name : 'None'}`);

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

    // Send initial state including the assigned tasks and current global progress
    socket.emit('initial_state', { 
      players: activeLobby,
      assignedTaskSet: chosenTaskSet,
      globalProgress: getGlobalProgress()
    });

    // Broadcast new progress to everyone since a new player joined (total tasks increased)
    io.emit('progress_update', {
      progress: getGlobalProgress()
    });
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

      // Recalculate and broadcast updated global progress
      io.emit('progress_update', {
        progress: getGlobalProgress()
      });
    }
  });

  socket.on('disconnect', () => {
    if (socket.playerProfile) {
      console.log(`Astronaut departed: ${socket.playerProfile.id}`);
      socket.broadcast.emit('player_left', { id: socket.playerProfile.id });

      // Recalculate and broadcast updated global progress since a player departed (total tasks decreased)
      io.emit('progress_update', {
        progress: getGlobalProgress()
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  SKELD SYSTEM ACTIVE: http://localhost:${PORT}/`);
  console.log(`======================================================\n`);
});