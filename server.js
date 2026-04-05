const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Readable } = require('stream');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });

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
      type TEXT DEFAULT 'text',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  try { await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent'`); } catch(e) {}
  try { await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'text'`); } catch(e) {}
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin TEXT`); } catch(e) {}
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
    const { pin } = req.body;
    if (!pin || pin.length !== 4) return res.status(400).json({ error: 'PIN deve ter 4 dígitos' });
    const existing = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      if (existing.rows[0].pin && existing.rows[0].pin !== pin) return res.status(401).json({ error: 'PIN incorreto' });
      if (!existing.rows[0].pin) await pool.query('UPDATE users SET pin = $1 WHERE phone = $2', [pin, phone]);
      return res.json({ user: existing.rows[0] });
    }
    const result = await pool.query('INSERT INTO users (name, phone, user_id, pin) VALUES ($1, $2, $3, $4) RETURNING *', [name, phone, userId, pin]);
    res.json({ user: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.get('/user/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, phone, user_id FROM users WHERE user_id = $1', [req.params.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
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

// Upload audio
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'video', folder: 'kamba-audio', format: 'mp3' },
      (error, result) => {
        if (error) return res.status(500).json({ error: 'Upload failed' });
        res.json({ url: result.secure_url });
      }
    );
    Readable.from(req.file.buffer).pipe(stream);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('register', (userId) => {
    onlineUsers[userId] = socket.id;
    console.log('Online:', userId);
  });

  socket.on('send_message', async (data) => {
    const { to, from, text, time, msgId, type } = data;
    const msgType = type || 'text';
    try {
      const result = await pool.query(
        'INSERT INTO messages (from_user, to_user, text, time, status, type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [from, to, text, time, 'sent', msgType]
      );
      const dbId = result.rows[0].id;
      const recipientSocket = onlineUsers[to];
      if (recipientSocket) {
        io.to(recipientSocket).emit('receive_message', { from, text, time, msgId: dbId, type: msgType });
        await pool.query('UPDATE messages SET status = $1 WHERE id = $2', ['delivered', dbId]);
        const senderSocket = onlineUsers[from];
        if (senderSocket) io.to(senderSocket).emit('message_status', { msgId, status: 'delivered' });
      }
    } catch (err) { console.error('Error:', err); }
  });

  socket.on('message_read', async (data) => {
    const { msgId, from } = data;
    try {
      await pool.query('UPDATE messages SET status = $1 WHERE id = $2', ['read', msgId]);
      const senderSocket = onlineUsers[from];
      if (senderSocket) io.to(senderSocket).emit('message_status', { msgId, status: 'read' });
    } catch (err) { console.error('Error:', err); }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of Object.entries(onlineUsers)) {
      if (socketId === socket.id) { delete onlineUsers[userId]; break; }
    }
  });
});

app.get('/', (req, res) => res.send('Kamba server running!'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Kamba server running on port', PORT));