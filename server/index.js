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
});

io.on('connection', (socket) => {
  io.to(socket.id).emit('init-room');

  socket.on('join-room', async (roomId) => {
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.to(roomId).emit('new-user', socket.id);

    const socketsInRoom = await io.in(roomId).allSockets();
    io.in(roomId).emit('room-user-change', Array.from(socketsInRoom));
  });

  socket.on('server-broadcast', (roomId, encryptedData, iv) => {
    socket.to(roomId).emit('server-broadcast', roomId, encryptedData, iv);
  });

  socket.on('server-volatile-broadcast', (roomId, encryptedData, iv) => {
    socket.to(roomId).volatile.emit('server-volatile-broadcast', roomId, encryptedData, iv);
  });

  socket.on('user-follow', async (payload) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit('user-follow', payload);
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

if (!isS3Configured) {
  fs.mkdirSync(LOCAL_SCENES_DIR, { recursive: true });
  fs.mkdirSync(LOCAL_FILES_DIR, { recursive: true });
}

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

// -------------------------------------------------------------
// REST API ROUTES
// -------------------------------------------------------------

// Health check & Storage Status
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    storageMode: isS3Configured ? 'AWS_S3' : 'LOCAL_FALLBACK',
    bucket: isS3Configured ? AWS_S3_BUCKET : null,
    region: isS3Configured ? AWS_REGION : null,
    collabStatus: 'online',
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
            try {
              const head = await s3.send(
                new HeadObjectCommand({
                  Bucket: AWS_S3_BUCKET,
                  Key: item.Key,
                })
              );
              if (head.Metadata && head.Metadata.boardname) {
                name = decodeURIComponent(head.Metadata.boardname);
              }
            } catch (e) {
              // fallback
            }
            return {
              id,
              name,
              lastModified: item.LastModified,
              size: item.Size,
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
          try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (content.name) name = content.name;
          } catch {}
          return {
            id,
            name,
            lastModified: stat.mtime,
            size: stat.size,
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
    const bodyData = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    let boardName = id;
    try {
      const parsed = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
      if (parsed.name) {
        boardName = parsed.name;
      }
    } catch {}

    if (isS3Configured) {
      await s3.send(
        new PutObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: `scenes/${id}.json`,
          Body: bodyData,
          ContentType: 'application/json',
          Metadata: {
            boardname: encodeURIComponent(boardName),
          },
        })
      );
    } else {
      fs.writeFileSync(path.join(LOCAL_SCENES_DIR, `${id}.json`), bodyData, 'utf-8');
    }

    res.json({ success: true, id, name: boardName, message: 'Scene saved successfully' });
  } catch (err) {
    console.error('Error saving scene:', err);
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

httpServer.listen(PORT, () => {
  console.log(`🚀 Excalidraw S3 Database & Realtime Collab running on http://localhost:${PORT}`);
});
