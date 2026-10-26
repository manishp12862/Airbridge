import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Import or recreate the pure functions from transfer-core
import {
  DEFAULT_CHUNK_SIZE,
  MAX_BUFFER_THRESHOLD,
  BUFFER_LOW_THRESHOLD,
  formatBytes,
  calculateProgress,
  createFileHeader,
  createDoneSignal,
  isControlMessage,
  parseIncomingChunk,
  sliceFileOffsets,
  shouldWaitBackpressure
} from '../client/src/transfer-core.ts';

test('1. Protocol: File Header and Done message structures', () => {
  const header = createFileHeader('vacation_video.mp4', 104857600, 'video/mp4');
  assert.equal(header.type, 'header');
  assert.equal(header.name, 'vacation_video.mp4');
  assert.equal(header.size, 104857600);
  assert.equal(header.mimeType, 'video/mp4');

  const done = createDoneSignal();
  assert.equal(done.type, 'done');

  assert.equal(isControlMessage(header), true);
  assert.equal(isControlMessage(done), true);
  assert.equal(isControlMessage({ type: 'other' }), false);
  assert.equal(isControlMessage(new Uint8Array([1, 2, 3])), false);
  assert.equal(isControlMessage(null), false);
  assert.equal(isControlMessage(undefined), false);
});

test('2. UI: formatBytes helper formats sizes accurately across all units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1 MB');
  assert.equal(formatBytes(52428800), '50 MB');
  assert.equal(formatBytes(1073741824), '1 GB');
  assert.equal(formatBytes(10737418240), '10 GB');
});

test('3. UI: calculateProgress computes percentage and speed correctly', () => {
  const startTime = 1000;
  const currentTime = 3000; // 2 seconds elapsed
  const loaded = 10485760; // 10 MB
  const total = 52428800;  // 50 MB

  const p = calculateProgress(loaded, total, startTime, currentTime);
  assert.equal(p.percent, 20); // 10 / 50 = 20%
  assert.equal(p.formattedLoaded, '10 MB');
  assert.equal(p.formattedTotal, '50 MB');
  assert.equal(p.speedMBs, '5.0 MB/s'); // 10MB in 2s = 5MB/s
});

test('4. Streaming: sliceFileOffsets partitions any file size correctly into 16KB chunks', () => {
  // Test case A: file smaller than chunk size
  const smallSlices = sliceFileOffsets(500, DEFAULT_CHUNK_SIZE);
  assert.equal(smallSlices.length, 1);
  assert.equal(smallSlices[0].offset, 0);
  assert.equal(smallSlices[0].size, 500);

  // Test case B: file exact multiple of 16KB
  const exactSize = DEFAULT_CHUNK_SIZE * 4;
  const exactSlices = sliceFileOffsets(exactSize, DEFAULT_CHUNK_SIZE);
  assert.equal(exactSlices.length, 4);
  assert.equal(exactSlices.reduce((sum, s) => sum + s.size, 0), exactSize);

  // Test case C: file with remainder chunk (e.g. 50 KB)
  const arbitrarySize = 50 * 1024;
  const arbitrarySlices = sliceFileOffsets(arbitrarySize, DEFAULT_CHUNK_SIZE);
  const totalChunked = arbitrarySlices.reduce((sum, s) => sum + s.size, 0);
  assert.equal(totalChunked, arbitrarySize);
  assert.equal(arbitrarySlices[arbitrarySlices.length - 1].size, (50 * 1024) % DEFAULT_CHUNK_SIZE);
});

test('5. Backpressure: buffer threshold correctly detects when to pause sending', () => {
  // Safe zone (< 64KB)
  assert.equal(shouldWaitBackpressure(0, MAX_BUFFER_THRESHOLD), false);
  assert.equal(shouldWaitBackpressure(32 * 1024, MAX_BUFFER_THRESHOLD), false);
  assert.equal(shouldWaitBackpressure(64 * 1024, MAX_BUFFER_THRESHOLD), false);

  // Buffer full (> 64KB) - MUST pause to prevent iOS/Android SCTP buffer overflow
  assert.equal(shouldWaitBackpressure(65 * 1024, MAX_BUFFER_THRESHOLD), true);
  assert.equal(shouldWaitBackpressure(1024 * 1024, MAX_BUFFER_THRESHOLD), true);
});

test('6. Binary Parser: parseIncomingChunk handles Uint8Array, ArrayBuffer, and ArrayBufferView', () => {
  const original = new Uint8Array([10, 20, 30, 40, 50]);

  // Uint8Array directly
  const parsed1 = parseIncomingChunk(original);
  assert.deepEqual(Array.from(parsed1), [10, 20, 30, 40, 50]);

  // ArrayBuffer directly
  const parsed2 = parseIncomingChunk(original.buffer);
  assert.deepEqual(Array.from(parsed2), [10, 20, 30, 40, 50]);

  // Sub-view with offset and length
  const subView = new Uint8Array(original.buffer, 1, 3);
  const parsed3 = parseIncomingChunk(subView);
  assert.deepEqual(Array.from(parsed3), [20, 30, 40]);
});

test('7. End-to-End Simulation: Chunking, simulated transfer, and byte-for-byte MD5 verification', () => {
  // Generate 256 KB of random binary data (simulating a high-res image / document)
  const testBytes = crypto.randomBytes(256 * 1024);
  const originalHash = crypto.createHash('sha256').update(testBytes).digest('hex');

  // Sender chunks the file
  const slices = sliceFileOffsets(testBytes.length, DEFAULT_CHUNK_SIZE);
  const sentChunks = [];

  for (const s of slices) {
    const chunkBuffer = testBytes.subarray(s.offset, s.offset + s.size);
    // Simulating PeerJS serialization & network transmission
    sentChunks.push(new Uint8Array(chunkBuffer));
  }

  // Receiver receives and processes chunks
  const receivedChunks = [];
  let receivedBytes = 0;

  for (const chunk of sentChunks) {
    const parsed = parseIncomingChunk(chunk);
    assert.ok(parsed);
    receivedChunks.push(parsed);
    receivedBytes += parsed.byteLength;
  }

  assert.equal(receivedBytes, testBytes.length);

  // Combine receiver chunks and verify hash matches byte-for-byte
  const reconstructed = Buffer.concat(receivedChunks.map(c => Buffer.from(c)));
  const reconstructedHash = crypto.createHash('sha256').update(reconstructed).digest('hex');

  assert.equal(reconstructedHash, originalHash, 'SHA-256 hash of sent and received file must match perfectly');
});
