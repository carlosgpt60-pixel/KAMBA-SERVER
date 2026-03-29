const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
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
  try {
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent'`);
  } catch(e) { console.log('Status column already exists'); }
  console.log('Database ready!');
}

initDB();

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
  allowEIO3: true,
  transports: ['polling', 'websocket']
});

const onlineUsers = {};

app.post('/register', async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  const userId = 'user_' + Math.random().toString(36).substr(2, 8);
  try {
    const existing = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) return res.json({ user: existing.rows[0] });
    const result = await pool.query('INSERT INTO users (name, phone, user_id) VALUES ($1, $2, $3) RETURNING *', [name, phone, userId]);
    res.json({ user: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/search/:phone', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, phone, user_id FROM users WHERE phone = $1', [req.params.phone]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/messages/:userId1/:userId2', async (req, res) => {
  const { userId1, userId2 } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM messages WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1) ORDER BY created_at ASC`,
      [userId1, userId2]
    );
    res.json({ messages: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('register', (userId) => {
    onlineUsers[userId] = socket.id;
    console.log('Online:', userId);
  });

  socket.on('send_message', async (data) => {
    const { to, from, text, time, msgId } = data;
    console.log(`Message from ${from} to ${to}: ${text}`);
    try {
      const result = await pool.query(
        'INSERT INTO messages (from_user, to_user, text, time, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [from, to, text, time, 'sent']
      );
      const dbId = result.rows[0].id;
      const recipientSocket = onlineUsers[to];
      console.log(`Recipient socket for ${to}:`, recipientSocket);
      if (recipientSocket) {
        io.to(recipientSocket).emit('receive_message', { from, text, time, msgId: dbId });
        await pool.query('UPDATE messages SET status = $1 WHERE id = $2', ['delivered', dbId]);
        const senderSocket = onlineUsers[from];
        if (senderSocket) io.to(senderSocket).emit('message_status', { msgId, status: 'delivered' });
      }
    } catch (err) { console.error('Error saving message:', err); }
  });

  socket.on('message_read', async (data) => {
    const { msgId, from } = data;
    try {
      await pool.query('UPDATE messages SET status = $1 WHERE id = $2', ['read', msgId]);
      const senderSocket = onlineUsers[from];
      if (senderSocket) io.to(senderSocket).emit('message_status', { msgId, status: 'read' });
    } catch (err) { console.error('Error updating read status:', err); }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of Object.entries(onlineUsers)) {
      if (socketId === socket.id) { delete onlineUsers[userId]; console.log('Offline:', userId); break; }
    }
  });
});

app.get('/', (req, res) => res.send('Kamba server running!'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Kamba server running on port', PORT));
