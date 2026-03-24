const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      user_id TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      text TEXT NOT NULL,
      time TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready!');
}

initDB();

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const onlineUsers = {};

// Register user
app.post('/register', async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  const userId = 'user_' + Math.random().toString(36).substr(2, 8);
  try {
    const existing = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.json({ user: existing.rows[0] });
    }
    const result = await pool.query(
      'INSERT INTO users (name, phone, user_id) VALUES ($1, $2, $3) RETURNING *',
      [name, phone, userId]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Search user by phone
app.get('/search/:phone', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, phone, user_id FROM users WHERE phone = $1', [req.params.phone]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get message history
app.get('/messages/:userId1/:userId2', async (req, res) => {
  const { userId1, userId2 } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM messages WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1) ORDER BY created_at ASC`,
      [userId1, userId2]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('register', (userId) => {
    onlineUsers[userId] = socket.id;
    console.log('User online:', userId);
  });

  socket.on('send_message', async (data) => {
    const { to, from, text, time } = data;
    try {
      await pool.query(
        'INSERT INTO messages (from_user, to_user, text, time) VALUES ($1, $2, $3, $4)',
        [from, to, text, time]
      );
    } catch (err) {
      console.error('Error saving message:', err);
    }
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) {
      io.to(recipientSocket).emit('receive_message', { from, text, time });
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of Object.entries(onlineUsers)) {
      if (socketId === socket.id) {
        delete onlineUsers[userId];
        break;
      }
    }
  });
});

app.get('/', (req, res) => res.send('Kamba server running!'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Kamba server running on port', PORT);
});