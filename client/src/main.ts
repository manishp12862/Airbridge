import QRCode from 'qrcode';

declare const Peer: any;

// -------------------------------------------------------------
// CONSTANTS & CONFIGURATION
// -------------------------------------------------------------
const CHUNK_SIZE = 64 * 1024; // 64 KB chunks: optimal for iOS Safari & Android
const PEER_PREFIX = 'airbridge-v1-';

// -------------------------------------------------------------
// STATE
// -------------------------------------------------------------
let myPin = generateRandomPin();
let peer: any = null;
let activeConnection: any = null;
let wakeLock: any = null;

interface IncomingFile {
  name: string;
  size: number;
  type: string;
  receivedBytes: number;
  chunks: ArrayBuffer[];
  startTime: number;
}
let currentIncomingFile: IncomingFile | null = null;

// -------------------------------------------------------------
// DOM ELEMENTS
// -------------------------------------------------------------
const pairingSection = document.getElementById('pairingSection')!;
const transferSection = document.getElementById('transferSection')!;
const myPinEl = document.getElementById('myPin')!;
const qrCanvas = document.getElementById('qrCanvas') as HTMLCanvasElement;
const joinForm = document.getElementById('joinForm') as HTMLFormElement;
const joinInput = document.getElementById('joinInput') as HTMLInputElement;
const connectionStatus = document.getElementById('connectionStatus')!;
const copyLinkBtn = document.getElementById('copyLinkBtn')!;
const disconnectBtn = document.getElementById('disconnectBtn')!;
const dropZone = document.getElementById('dropZone')!;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;

const transferProgressCard = document.getElementById('transferProgressCard')!;
const currentFileName = document.getElementById('currentFileName')!;
const transferPercentage = document.getElementById('transferPercentage')!;
const transferBytes = document.getElementById('transferBytes')!;
const transferSpeed = document.getElementById('transferSpeed')!;
const transferEta = document.getElementById('transferEta')!;
const progressBar = document.getElementById('progressBar')!;
const transferDoneBox = document.getElementById('transferDoneBox')!;
const downloadBtn = document.getElementById('downloadBtn') as HTMLAnchorElement;
const fileList = document.getElementById('fileList')!;
const wakeLockBadge = document.getElementById('wakeLockBadge')!;
const peerDeviceName = document.getElementById('peerDeviceName')!;

// -------------------------------------------------------------
// INITIALIZATION
// -------------------------------------------------------------
function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam && roomParam.length === 4) {
    joinInput.value = roomParam;
  }

  myPinEl.textContent = myPin;
  generateQRCode();
  setupEventListeners();
  initPeer();
  requestWakeLock();
}

function generateRandomPin(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateQRCode() {
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${myPin}`;
  QRCode.toCanvas(qrCanvas, shareUrl, {
    width: 154,
    margin: 0,
    color: {
      dark: '#090d16',
      light: '#ffffff'
    }
  });
}

// -------------------------------------------------------------
// SCREEN WAKE LOCK (Prevents iOS & Android sleep during transfers)
// -------------------------------------------------------------
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await (navigator as any).wakeLock.request('screen');
      wakeLockBadge.classList.remove('hidden');
      wakeLock.addEventListener('release', () => {
        wakeLockBadge.classList.add('hidden');
      });
    }
  } catch (err) {
    console.log('Wake Lock not supported or denied:', err);
  }
}

// -------------------------------------------------------------
// PEERJS CLOUD CONNECTION (Free & Serverless)
// -------------------------------------------------------------
function initPeer() {
  connectionStatus.textContent = 'Connecting to signaling network...';

  const fullId = `${PEER_PREFIX}${myPin}`;
  peer = new Peer(fullId, {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', () => {
    connectionStatus.textContent = `Online! Waiting for device to scan or enter PIN: ${myPin}`;

    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam && roomParam !== myPin) {
      connectToPeer(roomParam);
    }
  });

  peer.on('connection', (conn: any) => {
    handleConnection(conn);
  });

  peer.on('error', (err: any) => {
    console.error('Peer error:', err);
    if (err.type === 'unavailable-id') {
      myPin = generateRandomPin();
      myPinEl.textContent = myPin;
      generateQRCode();
      initPeer();
    } else if (err.type === 'peer-unavailable') {
      connectionStatus.textContent = '❌ PIN not found or device is offline. Check the number!';
    } else {
      connectionStatus.textContent = `Connection error: ${err.type}`;
    }
  });
}

function connectToPeer(targetPin: string) {
  connectionStatus.textContent = `Connecting to device ${targetPin}...`;
  const targetId = `${PEER_PREFIX}${targetPin}`;
  const conn = peer.connect(targetId, {
    reliable: true,
    serialization: "binary"
  });
  handleConnection(conn);
}

function handleConnection(conn: any) {
  activeConnection = conn;

  conn.on('open', () => {
    peerDeviceName.textContent = `Paired Device (${conn.peer.replace(PEER_PREFIX, 'PIN ')})`;
    showTransferView();
  });

  conn.on('data', (data: any) => {
    handleIncomingData(data);
  });

  conn.on('close', () => {
    resetToPairingView('Connection closed by peer.');
  });

  conn.on('error', (err: any) => {
    console.error('Connection error:', err);
    resetToPairingView('Connection error occurred.');
  });
}

// -------------------------------------------------------------
// FILE SENDER (5 - 10 GB Low-Memory Streaming)
// -------------------------------------------------------------
async function sendFile(file: File) {
  if (!activeConnection || !activeConnection.open) {
    alert('Please wait for device connection!');
    return;
  }

  activeConnection.send({
    type: 'header',
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream'
  });

  showProgressCard(file.name, file.size, false);

  let offset = 0;
  const startTime = Date.now();

  while (offset < file.size) {
    const dc = activeConnection.dataChannel;
    if (dc && dc.bufferedAmount > 1024 * 1024) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    const chunkSlice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await chunkSlice.arrayBuffer();

    activeConnection.send(buffer);

    offset += buffer.byteLength;
    updateProgress(offset, file.size, startTime);
  }

  activeConnection.send({ type: 'done' });
  addHistoryItem(file.name, file.size, 'sent');
}

// -------------------------------------------------------------
// FILE RECEIVER
// -------------------------------------------------------------
async function handleIncomingData(data: any) {
  // Check if JSON message (header or done)
  if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !(data instanceof Blob) && !(data.buffer instanceof ArrayBuffer)) {
    if (data.type === 'header') {
      currentIncomingFile = {
        name: data.name,
        size: data.size,
        type: data.mimeType,
        receivedBytes: 0,
        chunks: [],
        startTime: Date.now()
      };
      showProgressCard(data.name, data.size, true);
    } else if (data.type === 'done') {
      if (currentIncomingFile) {
        completeIncomingFile(currentIncomingFile);
        currentIncomingFile = null;
      }
    }
    return;
  }

  // Handle binary data: ArrayBuffer, Uint8Array, or Blob
  if (currentIncomingFile) {
    let buffer: ArrayBuffer;
    if (data instanceof Blob) {
      buffer = await data.arrayBuffer();
    } else if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (data && data.buffer instanceof ArrayBuffer) {
      buffer = data.buffer;
    } else {
      console.warn('Unknown binary chunk format:', data);
      return;
    }

    currentIncomingFile.chunks.push(buffer);
    currentIncomingFile.receivedBytes += buffer.byteLength;

    updateProgress(
      currentIncomingFile.receivedBytes,
      currentIncomingFile.size,
      currentIncomingFile.startTime
    );
  }
}

function completeIncomingFile(file: IncomingFile) {
  console.log("[AirBridge] Received chunks count:", file.chunks.length, "totalBytes:", file.receivedBytes);
  const blob = new Blob(file.chunks, { type: file.type || "application/octet-stream" });
  const objectUrl = URL.createObjectURL(blob);

  transferDoneBox.classList.remove("hidden");
  downloadBtn.href = objectUrl;
  downloadBtn.download = file.name;

  // Append download link to body for iOS Safari & Chrome compatibility
  document.body.appendChild(downloadBtn);
  setTimeout(() => {
    downloadBtn.click();
  }, 100);

  addHistoryItem(file.name, file.size, "received", objectUrl);
}

// -------------------------------------------------------------
// UI HELPERS
// -------------------------------------------------------------
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function updateProgress(loaded: number, total: number, startTime: number) {
  const percent = Math.min(100, Math.round((loaded / total) * 100));
  progressBar.style.width = `${percent}%`;
  transferPercentage.textContent = `${percent}%`;

  const elapsedSeconds = (Date.now() - startTime) / 1000;
  const speedBytesPerSec = elapsedSeconds > 0 ? loaded / elapsedSeconds : 0;

  transferBytes.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
  transferSpeed.textContent = `${(speedBytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;

  if (speedBytesPerSec > 0 && loaded < total) {
    const remainingBytes = total - loaded;
    const etaSec = Math.round(remainingBytes / speedBytesPerSec);
    transferEta.textContent = `ETA: ${etaSec}s`;
  } else {
    transferEta.textContent = 'ETA: 0s';
  }
}

function showProgressCard(name: string, _size: number, isReceiving: boolean) {
  transferProgressCard.classList.remove('hidden');
  transferDoneBox.classList.add('hidden');
  currentFileName.textContent = `${isReceiving ? 'Receiving: ' : 'Sending: '} ${name}`;
  progressBar.style.width = '0%';
  transferPercentage.textContent = '0%';
}

function showTransferView() {
  pairingSection.classList.add('hidden');
  transferSection.classList.remove('hidden');
}

function resetToPairingView(reason?: string) {
  pairingSection.classList.remove('hidden');
  transferSection.classList.add('hidden');
  if (reason) connectionStatus.textContent = reason;
}

function addHistoryItem(name: string, size: number, mode: 'sent' | 'received', downloadUrl?: string) {
  const empty = fileList.querySelector('.empty-files');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'history-item';
  item.innerHTML = `
    <div>
      <strong>${mode === 'sent' ? '↑ Sent' : '↓ Received'}:</strong> ${name}
      <span style="color: var(--text-dim); margin-left: 0.5rem">(${formatBytes(size)})</span>
    </div>
    ${downloadUrl ? `<a href="${downloadUrl}" download="${name}" class="btn btn-sm btn-secondary">Save</a>` : ''}
  `;
  fileList.prepend(item);
}

// -------------------------------------------------------------
// EVENT LISTENERS
// -------------------------------------------------------------
function setupEventListeners() {
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = joinInput.value.trim();
    if (pin.length === 4) {
      connectToPeer(pin);
    }
  });

  copyLinkBtn.addEventListener('click', async () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${myPin}`;
    await navigator.clipboard.writeText(shareUrl);
    copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyLinkBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Link
      `;
    }, 2000);
  });

  disconnectBtn.addEventListener('click', () => {
    activeConnection?.close();
    resetToPairingView('Disconnected.');
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer?.files.length) {
      Array.from(e.dataTransfer.files).forEach((file) => sendFile(file));
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) {
      Array.from(fileInput.files).forEach((file) => sendFile(file));
    }
  });
}

init();
