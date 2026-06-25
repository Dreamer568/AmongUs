const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');

const PORT = 3000;
const app = express();
const server = http.createServer(app);

const io = socketIo(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'game.html'));
});

const fs = require('fs');
let taskSets = [];
try {
  const filePath = path.join(__dirname, 'task_sets.json');
  if (fs.existsSync(filePath)) {
    const fileData = fs.readFileSync(filePath, 'utf8');
    taskSets = JSON.parse(fileData).task_sets;
    console.log(`Successfully loaded ${taskSets.length} task sets on startup.`);
  } else {
    console.warn("WARNING: task_sets.json was not found. Initializing with fallback task sets.");
    taskSets = [{
      name: "Fallback Set",
      tasks: [
        { id: "fallback_1", room: "Cafeteria", name: "Fix Wiring", file: "wires.html", params: "" },
        { id: "fallback_2", room: "MedBay", name: "Scan Body", file: "scan.html", params: "" }
      ]
    }];
  }
} catch (err) {
  console.error('CRITICAL: Failed to load task_sets.json. Using fallback task sets.', err);
  taskSets = [{
    name: "Fallback Set",
    tasks: [
      { id: "fallback_1", room: "Cafeteria", name: "Fix Wiring", file: "wires.html", params: "" },
      { id: "fallback_2", room: "MedBay", name: "Scan Body", file: "scan.html", params: "" }
    ]
  }];
}

function getConnectedSockets() {
  const namespace = io.of("/");
  if (namespace.sockets instanceof Map) {
    return Array.from(namespace.sockets.values());
  } else if (namespace.sockets && typeof namespace.sockets === 'object') {
    return Object.values(namespace.sockets);
  }
  if (namespace.connected && typeof namespace.connected === 'object') {
    return Object.values(namespace.connected);
  }
  return [];
}

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

function checkGameEndConditions(room) {
  if (!room.gameStarted) return;

  const livingImpostors = room.players.filter(p => p.isAlive && p.role === 'Impostor').length;
  const livingCrewmates = room.players.filter(p => p.isAlive && p.role === 'Crewmate').length;
  const progress = getRoomProgress(room);

  if (progress >= 100.0) {
    endActiveGame(room, 'Crewmates');
    return;
  }

  if (livingImpostors === 0) {
    endActiveGame(room, 'Crewmates');
    return;
  }

  if (livingImpostors >= livingCrewmates) {
    endActiveGame(room, 'Impostors');
    return;
  }
}

function endActiveGame(room, winningTeam) {
  room.gameStarted = false;
  room.inMeeting = false;

  console.log(`Room ${room.code} ended. Winners: ${winningTeam}`);
  io.to(room.code).emit('game_over', {
    winnerTeam: winningTeam,
    players: room.players.map(p => ({
      id: p.id,
      username: p.username,
      color: p.color,
      role: p.role
    }))
  });
}

io.on('connection', (socket) => {
  console.log('Astronaut linked via Socket.io secure connection.');

  socket.on('webrtc_signal', (data) => {
    if (socket.roomCode) {
      io.to(data.targetId).emit('webrtc_signal', {
        senderId: socket.id,
        signalData: data.signalData
      });
    }
  });

  socket.on('initiate_peer_connection', (data) => {
    io.to(data.targetId).emit('initiate_peer_connection', {
      senderId: socket.id
    });
  });

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
      isHost: true,
      isAlive: true,
      lastKillTime: 0
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
      gameStarted: false,
      votes: {},
      inMeeting: false
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
      isHost: false,
      isAlive: true,
      lastKillTime: 0
    };

    if (room.gameStarted) {
      if (taskSets.length > 0) {
        socket.playerProfile.assignedTaskSet = taskSets[Math.floor(Math.random() * taskSets.length)];
      }
      socket.playerProfile.role = 'Crewmate';
    }

    room.players.push(socket.playerProfile);
    socket.join(code);

    console.log(`Player joined room ${code}: ${socket.playerProfile.username}`);

    socket.emit('room_joined', {
      roomCode: code,
      roomState: room,
      playerProfile: socket.playerProfile
    });

    socket.to(code).emit('player_joined', socket.playerProfile);

    if (room.gameStarted) {
      io.to(code).emit('progress_update', {
        progress: getRoomProgress(room)
      });
    }
  });

  socket.on('start_game', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id || room.gameStarted) return;

    let impostorCount = parseInt(room.settings.impostors) || 1;
    if (room.players.length > 1) {
      impostorCount = Math.max(1, Math.min(impostorCount, room.players.length - 1));
    } else {
      impostorCount = 0;
    }

    const shuffledIndex = Array.from({ length: room.players.length }, (_, i) => i);
    for (let i = shuffledIndex.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledIndex[i], shuffledIndex[j]] = [shuffledIndex[j], shuffledIndex[i]];
    }

    const impostorIndices = new Set(shuffledIndex.slice(0, impostorCount));

    room.players.forEach((p, index) => {
      p.role = impostorIndices.has(index) ? 'Impostor' : 'Crewmate';
      p.completedTasks = [];
      p.lastKillTime = 0;
      p.isAlive = true;
      p.position = { x: 6.79, y: 5.90, z: -23.93 };
      if (taskSets.length > 0) {
        p.assignedTaskSet = taskSets[Math.floor(Math.random() * taskSets.length)];
      }
    });

    room.gameStarted = true;
    console.log(`Game starting in Room ${room.code} with ${impostorCount} impostor(s).`);

    const connectedSockets = getConnectedSockets();
    connectedSockets.forEach((s) => {
      if (s.roomCode === room.code && s.playerProfile) {
        const profile = room.players.find(p => p.id === s.id);
        if (profile) {
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

  socket.on('task_complete', (data) => {
    if (socket.roomCode && socket.playerProfile) {
      const room = rooms.get(socket.roomCode);
      if (!room) return;

      const profile = room.players.find(p => p.id === socket.id);
      if (profile) {
        profile.completedTasks.push(data.taskName);
        console.log(`Task verified in Room ${room.code}: [${data.taskName}] completed by ${data.username}`);

        io.to(room.code).emit('task_broadcast', {
          id: socket.id,
          username: data.username,
          taskName: data.taskName
        });

        io.to(room.code).emit('progress_update', {
          progress: getRoomProgress(room)
        });

        checkGameEndConditions(room);
      }
    }
  });

  socket.on('call_emergency_meeting', () => {
    if (socket.roomCode && socket.playerProfile) {
      const room = rooms.get(socket.roomCode);
      if (!room || !room.gameStarted || room.inMeeting) return;

      const caller = room.players.find(p => p.id === socket.id);
      if (!caller || !caller.isAlive) return;

      console.log(`Room ${room.code}: Emergency Meeting called by button!`);
      triggerMeetingSequence(room, caller.username, caller.color);
    }
  });

  socket.on('kill_player', (data) => {
    if (socket.roomCode && socket.playerProfile) {
      const room = rooms.get(socket.roomCode);
      if (!room || !room.gameStarted) return;

      const killer = room.players.find(p => p.id === socket.id);
      if (!killer || killer.role !== 'Impostor' || !killer.isAlive) return;

      const victim = room.players.find(p => p.id === data.victimId);
      if (!victim || !victim.isAlive) return;

      if (victim.role === 'Impostor') {
        console.log(`Rejected kill: Impostor ${killer.username} tried to eliminate teammate Impostor ${victim.username}`);
        return;
      }

      const now = Date.now();
      if (killer.lastKillTime && (now - killer.lastKillTime < 25000)) {
        console.log(`Rejected kill: Cooldown is active for ${killer.username}`);
        return;
      }

      killer.lastKillTime = now;
      victim.isAlive = false;
      console.log(`Room ${room.code}: [${victim.username}] was eliminated by [${killer.username}]`);

      io.to(room.code).emit('player_died', {
        victimId: victim.id,
        killerId: killer.id,
        position: victim.position
      });
    }
  });

  socket.on('report_body', (data) => {
    if (socket.roomCode && socket.playerProfile) {
      const room = rooms.get(socket.roomCode);
      if (!room || !room.gameStarted || room.inMeeting) return;

      const reporter = room.players.find(p => p.id === socket.id);
      if (!reporter || !reporter.isAlive) return;

      console.log(`Room ${room.code}: Body reported by [${reporter.username}]`);
      triggerMeetingSequence(room, reporter.username, reporter.color);
    }
  });

  socket.on('cast_vote', (data) => {
    if (socket.roomCode && socket.playerProfile) {
      const room = rooms.get(socket.roomCode);
      if (!room || !room.inMeeting) return;

      const voter = room.players.find(p => p.id === socket.id);
      if (!voter || !voter.isAlive) {
        console.log(`Vote rejected: [${voter?.username || socket.id}] is dead.`);
        return;
      }

      room.votes[socket.id] = data.targetId;
      console.log(`Room ${room.code}: [${voter.username}] voted for [${data.targetId}]`);

      io.to(room.code).emit('vote_update', {
        voters: Object.keys(room.votes),
        votes: room.votes
      });

      const alivePlayers = room.players.filter(p => p.isAlive);
      if (Object.keys(room.votes).length >= alivePlayers.length) {
        processVotingResults(room);
      }
    }
  });

  socket.on('play_again', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;

    room.gameStarted = false;
    room.inMeeting = false;
    room.votes = {};

    room.players.forEach(p => {
      p.isAlive = true;
      p.role = 'Crewmate';
      p.completedTasks = [];
      p.assignedTaskSet = null;
      p.position = { x: 6.79, y: 5.90, z: -23.93 };
      p.lastKillTime = 0;
    });

    console.log(`Room ${room.code}: Lobby reset requested by host.`);
    io.to(room.code).emit('return_to_lobby', { roomState: room });
  });

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
          checkGameEndConditions(room);
        }
      }
      socket.emit('left_room');
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomCode) {
      const code = socket.roomCode;
      const room = rooms.get(code);

      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        socket.to(code).emit('player_left', { id: socket.id });

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
          checkGameEndConditions(room);
        }
      }
    }
  });
});

function triggerMeetingSequence(room, reporterName, reporterColor) {
  room.inMeeting = true;
  room.votes = {};

  room.players.forEach(p => {
    p.position = { x: 6.79, y: 5.90, z: -23.93 };
  });

  const aliveList = room.players.map(p => ({
    id: p.id,
    username: p.username,
    color: p.color,
    isAlive: p.isAlive
  }));

  io.to(room.code).emit('meeting_started', {
    reporterName,
    reporterColor,
    alivePlayers: aliveList
  });
}

function processVotingResults(room) {
  room.inMeeting = false;

  const voteCounts = {};
  let maxVotes = 0;
  let ejectedId = null;
  let isTie = false;

  Object.values(room.votes).forEach(targetId => {
    if (targetId !== 'skip') {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      if (voteCounts[targetId] > maxVotes) {
        maxVotes = voteCounts[targetId];
        ejectedId = targetId;
        isTie = false;
      } else if (voteCounts[targetId] === maxVotes) {
        isTie = true;
      }
    }
  });

  const skipCount = Object.values(room.votes).filter(v => v === 'skip').length;
  if (skipCount >= maxVotes) {
    ejectedId = null;
  } else if (isTie) {
    ejectedId = null;
  }

  let ejectedPlayer = null;
  if (ejectedId) {
    ejectedPlayer = room.players.find(p => p.id === ejectedId);
    if (ejectedPlayer) {
      ejectedPlayer.isAlive = false;
    }
  }

  const remainingImpostors = room.players.filter(p => p.isAlive && p.role === 'Impostor').length;

  io.to(room.code).emit('meeting_ended', {
    ejectedPlayer: ejectedPlayer ? {
      id: ejectedPlayer.id,
      username: ejectedPlayer.username,
      role: ejectedPlayer.role
    } : null,
    remainingImpostors: remainingImpostors
  });

  checkGameEndConditions(room);
}

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  SKELD SYSTEM ACTIVE: http://localhost:${PORT}/`);
  console.log(`======================================================\n`);
});