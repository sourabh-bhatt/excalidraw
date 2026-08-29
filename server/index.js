import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: ['application/octet-stream', 'image/*'], limit: '100mb' }));

// -------------------------------------------------------------
// SOCKET.IO REAL-TIME COLLABORATION
// -------------------------------------------------------------
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 50 * 1024 * 1024,
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling'],
});

io.on('connection', (socket) => {
  io.to(socket.id).emit('init-room');

  socket.on('join-room', async (roomId) => {
    socket.join(roomId);
    socket.data.roomId = roomId;

    const socketsInRoom = await io.in(roomId).allSockets();
    const socketsList = Array.from(socketsInRoom);

    if (socketsInRoom.size === 1) {
      // First user in room: immediately notify client so scene is loaded from DB without 5s timeout delay
      socket.emit('first-in-room');
    } else {
      // Existing room: tell other active users to broadcast SCENE_INIT to new user
      socket.to(roomId).emit('new-user', socket.id);
    }

    io.in(roomId).emit('room-user-change', socketsList);
  });

  socket.on('server-broadcast', (roomId, encryptedData, iv) => {
    socket.to(roomId).emit('client-broadcast', encryptedData, iv);
  });

  socket.on('server-volatile-broadcast', (roomId, encryptedData, iv) => {
    socket.to(roomId).volatile.emit('client-broadcast', encryptedData, iv);
  });

  socket.on('user-follow', async (payload) => {
    if (!payload || !payload.userToFollow || !payload.userToFollow.socketId) return;
    const room = `follow@${payload.userToFollow.socketId}`;
    switch (payload.action) {
      case 'FOLLOW': {
        await socket.join(room);
        const sockets = await io.in(room).allSockets();
        const followedBy = Array.from(sockets);
        io.to(payload.userToFollow.socketId).emit('user-follow-room-change', followedBy);
        break;
      }
      case 'UNFOLLOW': {
        await socket.leave(room);
        const sockets = await io.in(room).allSockets();
        const followedBy = Array.from(sockets);
        io.to(payload.userToFollow.socketId).emit('user-follow-room-change', followedBy);
        break;
      }
    }
  });

  socket.on('disconnecting', async () => {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        const socketsInRoom = await io.in(room).allSockets();
        const clients = Array.from(socketsInRoom).filter((id) => id !== socket.id);
        socket.to(room).emit('room-user-change', clients);
      }
    }
  });
});

// -------------------------------------------------------------
// AWS S3 CONFIGURATION
// -------------------------------------------------------------
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;

const isS3Configured = Boolean(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_S3_BUCKET);

let s3 = null;
if (isS3Configured) {
  s3 = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });
  console.log(`[Storage] Connected to AWS S3 Bucket: "${AWS_S3_BUCKET}" (${AWS_REGION})`);
} else {
  console.warn('[Storage] AWS S3 credentials not fully configured. Using local fallback directory "./local-storage"');
}

// Local fallback storage helper
const LOCAL_STORAGE_DIR = path.join(__dirname, 'local-storage');
const LOCAL_SCENES_DIR = path.join(LOCAL_STORAGE_DIR, 'scenes');
const LOCAL_FILES_DIR = path.join(LOCAL_STORAGE_DIR, 'files');
const LOCAL_ROOMS_DIR = path.join(LOCAL_STORAGE_DIR, 'rooms');

if (!isS3Configured) {
  fs.mkdirSync(LOCAL_SCENES_DIR, { recursive: true });
  fs.mkdirSync(LOCAL_FILES_DIR, { recursive: true });
  fs.mkdirSync(LOCAL_ROOMS_DIR, { recursive: true });
}

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// -------------------------------------------------------------
// REST API ROUTES
// -------------------------------------------------------------

// -------------------------------------------------------------
// AUTHENTICATION & SECURITY
// -------------------------------------------------------------
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shi*&^874sdf8sdafjh!!!!!#@@@@';

// Login endpoint
app.post('/api/v1/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const tokenPayload = Buffer.from(
      JSON.stringify({
        username: ADMIN_USERNAME,
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days persistent session
      })
    ).toString('base64');

    return res.json({
      success: true,
      token: tokenPayload,
      user: {
        username: ADMIN_USERNAME,
        role: 'admin',
      },
    });
  }
  return res.status(401).json({ success: false, error: 'Invalid username or password' });
});

// Verify session endpoint
app.get('/api/v1/auth/verify', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
      if (decoded.username === ADMIN_USERNAME && (!decoded.exp || decoded.exp > Date.now())) {
        return res.json({ success: true, user: { username: decoded.username, role: decoded.role } });
      }
    } catch {}
  }
  return res.status(401).json({ success: false, error: 'Invalid or expired session' });
});

// Health check & Storage Status
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    storageMode: isS3Configured ? 'AWS_S3' : 'LOCAL_FALLBACK',
    bucket: isS3Configured ? AWS_S3_BUCKET : null,
    region: isS3Configured ? AWS_REGION : null,
    collabStatus: 'online',
    authEnabled: true,
    timestamp: new Date().toISOString(),
  });
});

// 1. LIST SAVED SCENES
app.get('/api/v1/scenes', async (req, res) => {
  try {
    if (isS3Configured) {
      const data = await s3.send(
        new ListObjectsV2Command({
          Bucket: AWS_S3_BUCKET,
          Prefix: 'scenes/',
        })
      );

      const items = await Promise.all(
        (data.Contents || [])
          .filter((item) => item.Key.endsWith('.json'))
          .map(async (item) => {
            const id = item.Key.replace('scenes/', '').replace('.json', '');
            let name = id;
            let collabRoomId = null;
            let collabRoomKey = null;
            let lastCollabAt = null;

            try {
              const head = await s3.send(
                new HeadObjectCommand({
                  Bucket: AWS_S3_BUCKET,
                  Key: item.Key,
                })
              );
              if (head.Metadata) {
                if (head.Metadata.boardname) {
                  name = decodeURIComponent(head.Metadata.boardname);
                }
                if (head.Metadata.collabroomid) {
                  collabRoomId = head.Metadata.collabroomid;
                }
                if (head.Metadata.collabroomkey) {
                  collabRoomKey = head.Metadata.collabroomkey;
                }
                if (head.Metadata.lastcollabat) {
                  lastCollabAt = head.Metadata.lastcollabat;
                }
              }
            } catch (e) {
              // fallback
            }
            return {
              id,
              name,
              lastModified: item.LastModified,
              size: item.Size,
              collabRoomId,
              collabRoomKey,
              lastCollabAt,
            };
          })
      );

      return res.json({ success: true, scenes: items });
    } else {
      const files = fs.readdirSync(LOCAL_SCENES_DIR);
      const items = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const id = f.replace('.json', '');
          const filePath = path.join(LOCAL_SCENES_DIR, f);
          const stat = fs.statSync(filePath);
          let name = id;
          let collabRoomId = null;
          let collabRoomKey = null;
          let lastCollabAt = null;

          try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (content.name) name = content.name;
            if (content.collabRoomId) collabRoomId = content.collabRoomId;
            if (content.collabRoomKey) collabRoomKey = content.collabRoomKey;
            if (content.lastCollabAt) lastCollabAt = content.lastCollabAt;
          } catch {}
          return {
            id,
            name,
            lastModified: stat.mtime,
            size: stat.size,
            collabRoomId,
            collabRoomKey,
            lastCollabAt,
          };
        });
      return res.json({ success: true, scenes: items });
    }
  } catch (err) {
    console.error('Error listing scenes:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. SAVE OR UPDATE SCENE
app.post('/api/v1/scenes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let parsed = {};
    if (typeof req.body === 'object') {
      parsed = req.body;
    } else {
      try {
        parsed = JSON.parse(req.body);
      } catch {}
    }

    const boardName = parsed.name || id;
    const collabRoomId = parsed.collabRoomId || '';
    const collabRoomKey = parsed.collabRoomKey || '';
    const lastCollabAt = parsed.lastCollabAt || '';
    const bodyData = JSON.stringify(parsed);

    if (isS3Configured) {
      const metadata = {
        boardname: encodeURIComponent(boardName),
      };
      if (collabRoomId) metadata.collabroomid = collabRoomId;
      if (collabRoomKey) metadata.collabroomkey = collabRoomKey;
      if (lastCollabAt) metadata.lastcollabat = lastCollabAt;

      await s3.send(
        new PutObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: `scenes/${id}.json`,
          Body: bodyData,
          ContentType: 'application/json',
          Metadata: metadata,
        })
      );
    } else {
      fs.writeFileSync(path.join(LOCAL_SCENES_DIR, `${id}.json`), bodyData, 'utf-8');
    }

    res.json({
      success: true,
      id,
      name: boardName,
      collabRoomId: collabRoomId || null,
      collabRoomKey: collabRoomKey || null,
      lastCollabAt: lastCollabAt || null,
      message: 'Scene saved successfully',
    });
  } catch (err) {
    console.error('Error saving scene:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2.1 LINK LIVE COLLABORATION SESSION TO SCENE
app.post('/api/v1/scenes/:id/collab', async (req, res) => {
  try {
    const { id } = req.params;
    const { roomId, roomKey } = req.body || {};
    const lastCollabAt = new Date().toISOString();

    let existingScene = null;
    if (isS3Configured) {
      try {
        const getRes = await s3.send(
          new GetObjectCommand({
            Bucket: AWS_S3_BUCKET,
            Key: `scenes/${id}.json`,
          })
        );
        const buf = await streamToBuffer(getRes.Body);
        existingScene = JSON.parse(buf.toString('utf-8'));
      } catch (e) {}
    } else {
      const filePath = path.join(LOCAL_SCENES_DIR, `${id}.json`);
      if (fs.existsSync(filePath)) {
        existingScene = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    }

    if (existingScene) {
      existingScene.collabRoomId = roomId;
      existingScene.collabRoomKey = roomKey;
      existingScene.lastCollabAt = lastCollabAt;
      const bodyData = JSON.stringify(existingScene);

      if (isS3Configured) {
        await s3.send(
          new PutObjectCommand({
            Bucket: AWS_S3_BUCKET,
            Key: `scenes/${id}.json`,
            Body: bodyData,
            ContentType: 'application/json',
            Metadata: {
              boardname: encodeURIComponent(existingScene.name || id),
              collabroomid: roomId || '',
              collabroomkey: roomKey || '',
              lastcollabat: lastCollabAt,
            },
          })
        );
      } else {
        fs.writeFileSync(path.join(LOCAL_SCENES_DIR, `${id}.json`), bodyData, 'utf-8');
      }
    }

    res.json({ success: true, id, roomId, roomKey, lastCollabAt });
  } catch (err) {
    console.error('Error linking collab to scene:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. LOAD SCENE
app.get('/api/v1/scenes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (isS3Configured) {
      try {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: AWS_S3_BUCKET,
            Key: `scenes/${id}.json`,
          })
        );
        const buffer = await streamToBuffer(response.Body);
        const scene = JSON.parse(buffer.toString('utf-8'));
        return res.json(scene);
      } catch (s3Err) {
        if (s3Err.name === 'NoSuchKey' || s3Err.$metadata?.httpStatusCode === 404) {
          return res.status(404).json({ error: 'Scene not found in S3' });
        }
        throw s3Err;
      }
    } else {
      const filePath = path.join(LOCAL_SCENES_DIR, `${id}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Scene not found locally' });
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return res.json(data);
    }
  } catch (err) {
    console.error('Error loading scene:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. DELETE SCENE
app.delete('/api/v1/scenes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (isS3Configured) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: `scenes/${id}.json`,
        })
      );
    } else {
      const filePath = path.join(LOCAL_SCENES_DIR, `${id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    res.json({ success: true, id, message: 'Scene deleted' });
  } catch (err) {
    console.error('Error deleting scene:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. UPLOAD BINARY FILE / IMAGE
app.post('/api/v1/files/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    let bodyBuffer;

    if (Buffer.isBuffer(req.body)) {
      bodyBuffer = req.body;
    } else if (req.body && req.body.buffer) {
      bodyBuffer = Buffer.from(req.body.buffer, 'base64');
    } else if (typeof req.body === 'string') {
      bodyBuffer = Buffer.from(req.body);
    } else {
      bodyBuffer = Buffer.from(JSON.stringify(req.body));
    }

    if (isS3Configured) {
      await s3.send(
        new PutObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: `files/${id}`,
          Body: bodyBuffer,
          ContentType: contentType,
        })
      );
    } else {
      fs.writeFileSync(path.join(LOCAL_FILES_DIR, id), bodyBuffer);
    }

    res.json({ success: true, id });
  } catch (err) {
    console.error('Error uploading file:', err);
    res.status(500).json({ error: err.message });
  }
});

// 6. GET BINARY FILE / IMAGE
app.get('/api/v1/files/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (isS3Configured) {
      try {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: AWS_S3_BUCKET,
            Key: `files/${id}`,
          })
        );
        res.setHeader('Content-Type', response.ContentType || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        response.Body.pipe(res);
      } catch (s3Err) {
        if (s3Err.name === 'NoSuchKey' || s3Err.$metadata?.httpStatusCode === 404) {
          return res.status(404).json({ error: 'File not found in S3' });
        }
        throw s3Err;
      }
    } else {
      const filePath = path.join(LOCAL_FILES_DIR, id);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found locally' });
      }
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('Error fetching file:', err);
    res.status(500).json({ error: err.message });
  }
});

// 7. SAVE OR UPDATE ENCRYPTED COLLAB ROOM
app.post('/api/v1/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    if (isS3Configured) {
      await s3.send(
        new PutObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: `rooms/${id}.json`,
          Body: bodyData,
          ContentType: 'application/json',
        })
      );
    } else {
      fs.writeFileSync(path.join(LOCAL_ROOMS_DIR, `${id}.json`), bodyData, 'utf-8');
    }

    res.json({ success: true, id, message: 'Room saved successfully' });
  } catch (err) {
    console.error('Error saving room scene:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. LOAD ENCRYPTED COLLAB ROOM
app.get('/api/v1/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (isS3Configured) {
      try {
        const response = await s3.send(
          new GetObjectCommand({
            Bucket: AWS_S3_BUCKET,
            Key: `rooms/${id}.json`,
          })
        );
        const buffer = await streamToBuffer(response.Body);
        const roomData = JSON.parse(buffer.toString('utf-8'));
        return res.json(roomData);
      } catch (s3Err) {
        if (s3Err.name === 'NoSuchKey' || s3Err.$metadata?.httpStatusCode === 404) {
          return res.status(404).json({ error: 'Room not found in S3' });
        }
        throw s3Err;
      }
    } else {
      const filePath = path.join(LOCAL_ROOMS_DIR, `${id}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Room not found locally' });
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return res.json(data);
    }
  } catch (err) {
    console.error('Error loading room scene:', err);
    res.status(500).json({ error: err.message });
  }
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Excalidraw S3 Database & Realtime Collab running on http://localhost:${PORT}`);
});
