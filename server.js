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
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, user_id TEXT UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, from_user TEXT NOT NULL, to_user TEXT NOT NULL, text TEXT NOT NULL, time TEXT NOT NULL, type TEXT DEFAULT 'text', created_at TIMESTAMP DEFAULT NOW())`);
  try { await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to JSONB`); } catch(e) {}
  try { await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded BOOLEAN DEFAULT false`); } catch(e) {}
  try { await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'sent'`); } catch(e) {}
  try { await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'text'`); } catch(e) {}
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin TEXT`); } catch(e) {}
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kamba_number TEXT`); } catch(e) {}
  console.log('Database ready! v3');
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
  const { name, phone, pin } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  if (!pin || pin.length !== 4) return res.status(400).json({ error: 'PIN deve ter 4 dígitos' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN deve ter 4 números' });
  const userId = 'user_' + Math.random().toString(36).substr(2, 8);
  try {
    const existing = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      if (existing.rows[0].pin && existing.rows[0].pin !== pin) return res.status(401).json({ error: 'PIN incorreto' });
      if (!existing.rows[0].pin) await pool.query('UPDATE users SET pin = $1 WHERE phone = $2', [pin, phone]);
      return res.json({ user: existing.rows[0] });
    }
    const part1 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const part2 = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const kambaNumber = part1 + ' ' + part2;
    const result = await pool.query('INSERT INTO users (name, phone, user_id, pin, kamba_number) VALUES ($1, $2, $3, $4, $5) RETURNING *', [name, phone, userId, pin, kambaNumber]);
    res.json({ user: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/save-contact', async (req, res) => {
  const { userId, contactId, name } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS contacts (id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(user_id, contact_id))`);
    await pool.query(`INSERT INTO contacts (user_id, contact_id, name) VALUES ($1, $2, $3) ON CONFLICT (user_id, contact_id) DO UPDATE SET name = $3`, [userId, contactId, name]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/conversations/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const result = await pool.query(`SELECT CASE WHEN from_user = $1 THEN to_user ELSE from_user END as other_user, text as last_message, time, type FROM messages WHERE from_user = $1 OR to_user = $1 ORDER BY created_at DESC`, [userId]);
    const seen = new Set();
    const unique = result.rows.filter(row => { if (seen.has(row.other_user)) return false; seen.add(row.other_user); return true; });
    const contacts = await Promise.all(unique.map(async (row) => {
      const user = await pool.query('SELECT name, phone, user_id FROM users WHERE user_id = $1', [row.other_user]);
      if (user.rows.length === 0) return null;
      const contact = await pool.query('SELECT name FROM contacts WHERE user_id = $1 AND contact_id = $2', [userId, row.other_user]);
      const displayName = contact.rows.length > 0 ? contact.rows[0].name : user.rows[0].name;
      return { ...user.rows[0], name: displayName, lastMsg: row.last_message, time: row.time, unread: 0 };
    }));
    res.json({ contacts: contacts.filter(Boolean) });
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
    const result = await pool.query(`SELECT * FROM messages WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1) ORDER BY created_at ASC`, [userId1, userId2]);
    res.json({ messages: result.rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    console.log('Upload received, cloud:', process.env.CLOUDINARY_CLOUD_NAME, 'size:', req.file.size);
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'auto', folder: 'kamba-media' },
      (error, result) => {
        if (error) { console.error('Cloudinary error:', JSON.stringify(error)); return res.status(500).json({ error: error.message }); }
        console.log('Upload success:', result.secure_url);
        res.json({ url: result.secure_url });
      }
    );
    Readable.from(req.file.buffer).pipe(stream);
  } catch (err) { console.error('Upload error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/', (req, res) => res.send('Kamba server running!'));

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
      const result = await pool.query('INSERT INTO messages (from_user, to_user, text, time, status, type, reply_to, forwarded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', [from, to, text, time, 'sent', msgType, data.replyTo ? JSON.stringify(data.replyTo) : null, data.forwarded || false]);
      const dbId = result.rows[0].id;
      const recipientSocket = onlineUsers[to];
      if (recipientSocket) {
        io.to(recipientSocket).emit('receive_message', { from, text, time, msgId: dbId, type: msgType, replyTo: data.replyTo || null, forwarded: data.forwarded || false });
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

  socket.on('call_offer', (data) => {
    const { to, from, offer, callerName } = data;
    const recipientSocket = onlineUsers[to];
    console.log(`📞 Call from ${from} to ${to}, recipient: ${recipientSocket}`);
    if (recipientSocket) io.to(recipientSocket).emit('incoming_call', { from, offer, callerName });
    else console.log('❌ Recipient not online:', to);
  });

  socket.on('call_answer', (data) => {
    const { to, answer } = data;
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('call_answered', { answer });
  });

  socket.on('call_ice', (data) => {
    const { to, candidate } = data;
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('call_ice', { candidate });
  });

  socket.on('call_end', (data) => {
    const { to } = data;
    const recipientSocket = onlineUsers[to];
    if (recipientSocket) io.to(recipientSocket).emit('call_ended');
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of Object.entries(onlineUsers)) {
      if (socketId === socket.id) { delete onlineUsers[userId]; break; }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Kamba server running on port', PORT));