/**
 * AirBridge Transfer Core - Testable Pure Logic & Protocols
 */

export const DEFAULT_CHUNK_SIZE = 16 * 1024; // 16 KB chunks for WebRTC stability
export const MAX_BUFFER_THRESHOLD = 64 * 1024; // 64 KB maximum buffer in flight
export const BUFFER_LOW_THRESHOLD = 32 * 1024; // 32 KB threshold for bufferedamountlow

export interface FileHeader {
  type: 'header';
  name: string;
  size: number;
  mimeType: string;
}

export interface DoneSignal {
  type: 'done';
}

export interface ProgressInfo {
  percent: number;
  speedBytesPerSec: number;
  speedMBs: string;
  formattedLoaded: string;
  formattedTotal: string;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0 || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const safeI = Math.min(i, sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, safeI)).toFixed(2))} ${sizes[safeI]}`;
}

export function calculateProgress(loaded: number, total: number, startTime: number, currentTime = Date.now()): ProgressInfo {
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const elapsedSec = Math.max(0.001, (currentTime - startTime) / 1000);
  const speedBytesPerSec = loaded / elapsedSec;
  const speedMBs = (speedBytesPerSec / (1024 * 1024)).toFixed(1);

  return {
    percent,
    speedBytesPerSec,
    speedMBs: `${speedMBs} MB/s`,
    formattedLoaded: formatBytes(loaded),
    formattedTotal: formatBytes(total)
  };
}

export function createFileHeader(name: string, size: number, type?: string): FileHeader {
  return {
    type: 'header',
    name: name || 'file.bin',
    size: Math.max(0, size),
    mimeType: type || 'application/octet-stream'
  };
}

export function createDoneSignal(): DoneSignal {
  return { type: 'done' };
}

export function isControlMessage(data: any): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    !(data instanceof ArrayBuffer) &&
    !(data instanceof Uint8Array) &&
    !(typeof Blob !== 'undefined' && data instanceof Blob) &&
    !(data.buffer instanceof ArrayBuffer) &&
    (data.type === 'header' || data.type === 'done')
  );
}

export function parseIncomingChunk(data: any): Uint8Array | null {
  if (!data) return null;

  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data.buffer instanceof ArrayBuffer) {
    const offset = data.byteOffset || 0;
    const length = data.byteLength !== undefined ? data.byteLength : data.buffer.byteLength - offset;
    return new Uint8Array(data.buffer, offset, length);
  }

  return null;
}

export function sliceFileOffsets(totalSize: number, chunkSize = DEFAULT_CHUNK_SIZE): Array<{ offset: number; size: number }> {
  const slices: Array<{ offset: number; size: number }> = [];
  let offset = 0;
  while (offset < totalSize) {
    const size = Math.min(chunkSize, totalSize - offset);
    slices.push({ offset, size });
    offset += size;
  }
  return slices;
}

export function shouldWaitBackpressure(bufferedAmount: number, maxThreshold = MAX_BUFFER_THRESHOLD): boolean {
  return bufferedAmount > maxThreshold;
}
