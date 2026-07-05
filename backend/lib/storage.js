// R2 (S3-compatible) storage helper.
// Wraps the AWS SDK v3 S3 client pointed at Cloudflare R2.

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } =
  require('@aws-sdk/client-s3');

const endpoint = process.env.R2_ENDPOINT;
const bucket = process.env.R2_BUCKET;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

const enabled = !!(endpoint && bucket && accessKeyId && secretAccessKey);

if (!enabled) {
  console.warn('[storage] R2 env vars missing — upload endpoints will fail. Need R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
}

const s3 = enabled
  ? new S3Client({
      region: 'auto',                  // R2 ignores region but the SDK requires one
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: false,           // R2 prefers virtual-host style
    })
  : null;

async function uploadObject(key, body, contentType) {
  if (!enabled) throw new Error('Storage not configured (R2 env vars missing).');
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { key, bucket };
}

async function getObjectBuffer(key) {
  if (!enabled) throw new Error('Storage not configured.');
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  // resp.Body is a Node Readable stream; collect into buffer
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function getObjectStream(key, range) {
  if (!enabled) throw new Error('Storage not configured.');
  const params = { Bucket: bucket, Key: key };
  if (range) params.Range = range; // e.g. 'bytes=0-1023' — enables media seeking/streaming
  const resp = await s3.send(new GetObjectCommand(params));
  return {
    stream: resp.Body,
    contentType: resp.ContentType,
    contentLength: resp.ContentLength,
    contentRange: resp.ContentRange, // 'bytes 0-1023/1157990' when a range was requested
  };
}

async function deleteObject(key) {
  if (!enabled) throw new Error('Storage not configured.');
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function objectExists(key) {
  if (!enabled) return false;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

module.exports = {
  enabled,
  bucket,
  uploadObject,
  getObjectBuffer,
  getObjectStream,
  deleteObject,
  objectExists,
};
