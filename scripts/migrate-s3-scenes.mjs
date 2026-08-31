import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../server/.env') });

const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_S3_BUCKET) {
  console.error('Missing AWS credentials in server/.env');
  process.exit(1);
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function migrate() {
  console.log(`Starting S3 scene optimization on bucket: ${AWS_S3_BUCKET}...`);
  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: AWS_S3_BUCKET,
      Prefix: 'scenes/',
    })
  );

  for (const item of list.Contents || []) {
    if (!item.Key.endsWith('.json')) continue;
    console.log(`Checking scene: ${item.Key} (original size: ${(item.Size / 1024).toFixed(1)} KB)...`);

    const getRes = await s3.send(
      new GetObjectCommand({
        Bucket: AWS_S3_BUCKET,
        Key: item.Key,
      })
    );

    const buf = await streamToBuffer(getRes.Body);
    let sceneObj;
    try {
      sceneObj = JSON.parse(buf.toString('utf-8'));
    } catch (e) {
      console.warn(`Failed to parse JSON for ${item.Key}:`, e.message);
      continue;
    }

    let modified = false;
    if (sceneObj.files && typeof sceneObj.files === 'object') {
      for (const [fileId, fileData] of Object.entries(sceneObj.files)) {
        if (fileData && fileData.dataURL && fileData.dataURL.length > 32 * 1024) {
          console.log(`  Extracting large file ${fileId} (${(fileData.dataURL.length / 1024).toFixed(1)} KB) to files/${fileId}...`);
          
          await s3.send(
            new PutObjectCommand({
              Bucket: AWS_S3_BUCKET,
              Key: `files/${fileId}`,
              Body: Buffer.from(fileData.dataURL),
              ContentType: fileData.mimeType || 'text/plain',
            })
          );

          // Clear inline dataURL in scene JSON
          fileData.dataURL = '';
          modified = true;
        }
      }
    }

    if (modified) {
      const cleanJson = JSON.stringify(sceneObj);
      console.log(`  Updating scene ${item.Key} with optimized JSON (new size: ${(cleanJson.length / 1024).toFixed(1)} KB)...`);

      await s3.send(
        new PutObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: item.Key,
          Body: Buffer.from(cleanJson, 'utf-8'),
          ContentType: 'application/json',
          Metadata: {
            boardname: encodeURIComponent(sceneObj.name || item.Key),
            collabroomid: sceneObj.collabRoomId || '',
            collabroomkey: sceneObj.collabRoomKey || '',
            lastcollabat: sceneObj.lastCollabAt || '',
          },
        })
      );
      console.log(`  Successfully optimized ${item.Key}!`);
    } else {
      console.log(`  No large files to extract for ${item.Key}.`);
    }
  }

  console.log('Migration and optimization complete!');
}

migrate().catch(console.error);
