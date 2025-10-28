const GameRoom = require('./gameRoom');

const rooms = new Map();
let roomCounter = 1;

function createRoom({ name, maxPlayers = 8, persistent = false, id } = {}) {
  const roomId = id || generateRoomId(name);
  if (rooms.has(roomId)) {
    throw new Error('Room already exists');
  }
  const roomName = name && name.trim() ? name.trim() : `Neon-${roomCounter}`;
  const room = new GameRoom({ id: roomId, name: roomName, maxPlayers, persistent });
  rooms.set(roomId, room);
  roomCounter += 1;
  return room;
}

function generateRoomId(name = '') {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `room-${roomCounter}`;
  let candidate = base;
  let suffix = 1;
  while (rooms.has(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

function getRoom(id) {
  return rooms.get(id);
}

function listRooms() {
  return Array.from(rooms.values()).map((room) => room.getLobbyInfo());
}

function removeRoom(id) {
  const room = rooms.get(id);
  if (!room) return false;
  room.destroy();
  rooms.delete(id);
  return true;
}

function pruneRooms(maxIdleMs = 5 * 60 * 1000) {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (!room.persistent && room.isEmpty() && now - room.lastActivity > maxIdleMs) {
      removeRoom(id);
    }
  });
}

function ensureDefaultRooms() {
  if (rooms.size > 0) return;
  createRoom({ id: 'neon-core', name: 'Neon Core', maxPlayers: 8, persistent: true });
  createRoom({ id: 'pulse-drift', name: 'Pulse Drift', maxPlayers: 12, persistent: true });
  createRoom({ id: 'zenith-line', name: 'Zenith Line', maxPlayers: 6, persistent: true });
}

module.exports = {
  rooms,
  createRoom,
  getRoom,
  listRooms,
  removeRoom,
  pruneRooms,
  ensureDefaultRooms,
};
