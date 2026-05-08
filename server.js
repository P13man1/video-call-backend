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
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active users and messages
const activeUsers = new Map(); // socketId -> { username, anonymousId }
const messages = []; // Store last 100 messages
const MAX_MESSAGES = 100;

// Generate anonymous names
const anonymousNames = [
  'Anonymous Cat', 'Hidden Fox', 'Secret Owl', 'Mysterious Wolf',
  'Ghost User', 'Shadow Panther', 'Invisible Bear', 'Unknown Entity',
  'Faceless One', 'Nameless Wanderer', 'Silent Observer', 'Quiet Raven',
  'Stealth Tiger', 'Covert Eagle', 'Masked Raccoon', 'Veiled Serpent'
];

function getRandomAnonymousName() {
  return anonymousNames[Math.floor(Math.random() * anonymousNames.length)] + '_' + Math.floor(Math.random() * 1000);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Generate anonymous ID for this connection
  const anonymousId = getRandomAnonymousName();
  
  // Store user info
  activeUsers.set(socket.id, {
    username: null,
    anonymousId: anonymousId,
    isAnonymous: true
  });
  
  // Send connection success with anonymous ID
  socket.emit('connected', {
    anonymousId: anonymousId,
    message: 'Connected to chat! Say hello! 👋'
  });
  
  // Send chat history to new user
  socket.emit('chat-history', messages.slice(-MAX_MESSAGES));
  
  // Broadcast updated user count
  broadcastUserCount();
  
  // Handle user joining with username
  socket.on('set-username', (username) => {
    const user = activeUsers.get(socket.id);
    if (user && username && username.trim().length > 0) {
      // Check if username is taken
      let isTaken = false;
      for (let [id, u] of activeUsers.entries()) {
        if (u.username === username.trim() && id !== socket.id) {
          isTaken = true;
          break;
        }
      }
      
      if (!isTaken && username.trim().length < 20) {
        const oldName = user.username || user.anonymousId;
        user.username = username.trim();
        user.isAnonymous = false;
        activeUsers.set(socket.id, user);
        
        // Broadcast name change
        io.emit('user-name-changed', {
          oldName: oldName,
          newName: username.trim(),
          isAnonymous: false
        });
        
        socket.emit('username-set', { success: true, username: username.trim() });
      } else {
        socket.emit('username-set', { 
          success: false, 
          error: isTaken ? 'Username already taken' : 'Invalid username'
        });
      }
    }
  });
  
  // Handle staying anonymous
  socket.on('stay-anonymous', () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      socket.emit('username-set', { 
        success: true, 
        username: user.anonymousId,
        isAnonymous: true
      });
    }
  });
  
  // Handle new messages
  socket.on('send-message', (messageData) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    
    const displayName = user.username || user.anonymousId;
    const message = {
      id: Date.now() + Math.random(),
      username: displayName,
      text: messageData.text.substring(0, 500), // Limit message length
      timestamp: new Date().toISOString(),
      isAnonymous: user.isAnonymous,
      userId: socket.id
    };
    
    // Store message
    messages.push(message);
    if (messages.length > MAX_MESSAGES) {
      messages.shift();
    }
    
    // Broadcast to all users
    io.emit('new-message', message);
    console.log(`Message from ${displayName}: ${message.text}`);
  });
  
  // Handle typing indicators
  socket.on('typing', (isTyping) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      const displayName = user.username || user.anonymousId;
      socket.broadcast.emit('user-typing', {
        username: displayName,
        isTyping: isTyping
      });
    }
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      const displayName = user.username || user.anonymousId;
      console.log(`User disconnected: ${displayName}`);
      
      // Broadcast user left
      io.emit('user-left', {
        username: displayName,
        message: `${displayName} left the chat`
      });
    }
    
    activeUsers.delete(socket.id);
    broadcastUserCount();
  });
});

function broadcastUserCount() {
  const users = [];
  for (let [id, user] of activeUsers.entries()) {
    users.push({
      name: user.username || user.anonymousId,
      isAnonymous: user.isAnonymous
    });
  }
  
  io.emit('user-count', {
    count: activeUsers.size,
    users: users.slice(0, 20) // Send first 20 users
  });
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    users: activeUsers.size,
    messages: messages.length
  });
});

app.get('/', (req, res) => {
  res.send('Anonymous Chat Server Running');
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Chat server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
});
