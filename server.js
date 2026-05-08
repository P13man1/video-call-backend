const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');

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

// Database (in-memory)
const users = new Map(); // username -> { passwordHash, socketId, isOnline, calls: [] }
const activeCalls = new Map(); // callId -> { caller, callee, isActive }

// Helper functions
function generateCallId() {
  return Date.now().toString() + Math.random().toString(36).substring(2, 6);
}

// ========== AUTH ROUTES ==========
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  
  if (users.has(username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  
  const passwordHash = await bcrypt.hash(password, 10);
  users.set(username, { 
    passwordHash, 
    socketId: null, 
    isOnline: false,
    calls: []
  });
  
  res.json({ success: true, message: 'User registered successfully' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!users.has(username)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const user = users.get(username);
  const validPassword = await bcrypt.compare(password, user.passwordHash);
  
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  res.json({ success: true, username: username });
});

app.get('/api/users', (req, res) => {
  const onlineUsers = [];
  for (let [username, user] of users.entries()) {
    if (user.isOnline) {
      onlineUsers.push({ username, isOnline: true });
    }
  }
  res.json(onlineUsers);
});

// ========== SOCKET.IO HANDLING ==========
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);
  let currentUser = null;
  
  // Authenticate user
  socket.on('authenticate', async (username) => {
    if (users.has(username)) {
      const user = users.get(username);
      user.socketId = socket.id;
      user.isOnline = true;
      currentUser = username;
      
      socket.emit('authenticated', { 
        success: true, 
        username: username 
      });
      
      // Broadcast online status to all users
      io.emit('user-online', { username });
      
      // Send list of online users to this user
      const onlineUsers = [];
      for (let [name, u] of users.entries()) {
        if (u.isOnline && name !== username) {
          onlineUsers.push({ username: name });
        }
      }
      socket.emit('online-users', onlineUsers);
      
      console.log(`✅ ${username} authenticated`);
    }
  });
  
  // ========== PRIVATE MESSAGING ==========
  socket.on('private-message', ({ to, text }) => {
    if (!currentUser) return;
    
    const recipient = users.get(to);
    if (recipient && recipient.isOnline && recipient.socketId) {
      const message = {
        from: currentUser,
        text: text.substring(0, 500),
        timestamp: new Date().toISOString(),
        type: 'text'
      };
      
      // Send to recipient
      io.to(recipient.socketId).emit('private-message', message);
      
      // Confirm to sender
      socket.emit('message-sent', { to, text, timestamp: message.timestamp });
      
      console.log(`💬 Private message from ${currentUser} to ${to}`);
    } else {
      socket.emit('error', { message: 'User is offline' });
    }
  });
  
  // ========== AUDIO CALL SIGNALING ==========
  socket.on('call-user', ({ targetUsername }) => {
    if (!currentUser) {
      socket.emit('call-error', { message: 'You are not authenticated' });
      return;
    }
    
    const targetUser = users.get(targetUsername);
    
    if (!targetUser || !targetUser.isOnline || !targetUser.socketId) {
      socket.emit('call-error', { message: `${targetUsername} is offline` });
      return;
    }
    
    const callId = generateCallId();
    activeCalls.set(callId, {
      caller: currentUser,
      callee: targetUsername,
      isActive: true,
      startTime: Date.now()
    });
    
    // Store call in user's history
    const caller = users.get(currentUser);
    const callee = users.get(targetUsername);
    if (caller) caller.calls.push({ callId, with: targetUsername, timestamp: Date.now() });
    if (callee) callee.calls.push({ callId, with: currentUser, timestamp: Date.now() });
    
    // Notify target
    io.to(targetUser.socketId).emit('incoming-call', {
      callId,
      from: currentUser
    });
    
    console.log(`📞 Call from ${currentUser} to ${targetUsername}, ID: ${callId}`);
  });
  
  socket.on('accept-call', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call) {
      socket.emit('call-error', { message: 'Call no longer exists' });
      return;
    }
    
    const caller = users.get(call.caller);
    if (caller && caller.socketId) {
      io.to(caller.socketId).emit('call-accepted', { callId });
      console.log(`✅ Call ${callId} accepted by ${call.callee}`);
    }
  });
  
  socket.on('reject-call', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (call) {
      const caller = users.get(call.caller);
      if (caller && caller.socketId) {
        io.to(caller.socketId).emit('call-rejected', { callId });
      }
      activeCalls.delete(callId);
      console.log(`❌ Call ${callId} rejected by ${call.callee}`);
    }
  });
  
  socket.on('end-call', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (call) {
      const caller = users.get(call.caller);
      const callee = users.get(call.callee);
      
      if (caller && caller.socketId) {
        io.to(caller.socketId).emit('call-ended', { callId });
      }
      if (callee && callee.socketId) {
        io.to(callee.socketId).emit('call-ended', { callId });
      }
      
      activeCalls.delete(callId);
      console.log(`📞 Call ${callId} ended`);
    }
  });
  
  // WebRTC signaling for audio calls
  socket.on('call-offer', ({ callId, offer }) => {
    const call = activeCalls.get(callId);
    if (!call) return;
    
    const targetUser = users.get(call.callee);
    if (targetUser && targetUser.socketId) {
      io.to(targetUser.socketId).emit('call-offer', { callId, offer });
    }
  });
  
  socket.on('call-answer', ({ callId, answer }) => {
    const call = activeCalls.get(callId);
    if (!call) return;
    
    const caller = users.get(call.caller);
    if (caller && caller.socketId) {
      io.to(caller.socketId).emit('call-answer', { callId, answer });
    }
  });
  
  socket.on('ice-candidate', ({ callId, candidate }) => {
    const call = activeCalls.get(callId);
    if (!call) return;
    
    // Find the other participant
    const targetUsername = call.caller === currentUser ? call.callee : call.caller;
    const targetUser = users.get(targetUsername);
    
    if (targetUser && targetUser.socketId) {
      io.to(targetUser.socketId).emit('ice-candidate', { callId, candidate });
    }
  });
  
  // ========== DISCONNECT ==========
  socket.on('disconnect', () => {
    if (currentUser) {
      const user = users.get(currentUser);
      if (user) {
        user.isOnline = false;
        user.socketId = null;
        io.emit('user-offline', { username: currentUser });
        console.log(`🔴 ${currentUser} disconnected`);
      }
    }
    
    // End any active calls from this user
    for (let [callId, call] of activeCalls.entries()) {
      if (call.caller === currentUser || call.callee === currentUser) {
        const otherUser = call.caller === currentUser ? call.callee : call.caller;
        const other = users.get(otherUser);
        if (other && other.socketId) {
          io.to(other.socketId).emit('call-ended', { callId, reason: 'user-disconnected' });
        }
        activeCalls.delete(callId);
      }
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    onlineUsers: Array.from(users.values()).filter(u => u.isOnline).length,
    activeCalls: activeCalls.size
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket ready for calls and messages`);
});
