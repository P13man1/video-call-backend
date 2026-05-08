const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // In production, replace with your Vercel URL
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Store active rooms
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create or join a room
  socket.on('join-room', (roomId, userId) => {
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, []);
    }
    
    const roomUsers = rooms.get(roomId);
    if (!roomUsers.includes(userId)) {
      roomUsers.push(userId);
    }
    
    // Notify others in room
    socket.to(roomId).emit('user-connected', userId);
    
    console.log(`User ${userId} joined room ${roomId}`);
    console.log(`Room ${roomId} users:`, roomUsers);
    
    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`User ${userId} disconnected`);
      const roomUsers = rooms.get(roomId);
      if (roomUsers) {
        const index = roomUsers.indexOf(userId);
        if (index > -1) {
          roomUsers.splice(index, 1);
        }
        if (roomUsers.length === 0) {
          rooms.delete(roomId);
        }
      }
      socket.to(roomId).emit('user-disconnected', userId);
    });
    
    // WebRTC signaling
    socket.on('offer', (data) => {
      socket.to(roomId).emit('offer', {
        offer: data.offer,
        from: userId,
        to: data.to
      });
    });
    
    socket.on('answer', (data) => {
      socket.to(roomId).emit('answer', {
        answer: data.answer,
        from: userId,
        to: data.to
      });
    });
    
    socket.on('ice-candidate', (data) => {
      socket.to(roomId).emit('ice-candidate', {
        candidate: data.candidate,
        from: userId,
        to: data.to
      });
    });
  });
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});