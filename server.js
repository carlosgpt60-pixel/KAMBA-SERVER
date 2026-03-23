const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const users = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', (userId) => {
    users[userId] = socket.id;
    console.log('User registered:', userId);
  });

  socket.on('send_message', (data) => {
    const { to, from, text, time } = data;
    const recipientSocket = users[to];
    if (recipientSocket) {
      io.to(recipientSocket).emit('receive_message', { from, text, time });
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of Object.entries(users)) {
      if (socketId === socket.id) {
        delete users[userId];
        break;
      }
    }
  });
});

app.get('/', (req, res) => res.send('Kamba server running!'));

server.listen(3000, () => {
  console.log('Kamba server running on port 3000');
});

