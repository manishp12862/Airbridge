import QRCode from 'qrcode';
import {
  DEFAULT_CHUNK_SIZE,
  MAX_BUFFER_THRESHOLD,
  BUFFER_LOW_THRESHOLD,
  createFileHeader,
  createDoneSignal,
  isControlMessage,
  parseIncomingChunk,
  calculateProgress,
  formatBytes,
  shouldWaitBackpressure
} from './transfer-core';

declare const Peer: any;

// -------------------------------------------------------------
// CONSTANTS & CONFIGURATION
// -------------------------------------------------------------
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
  chunks: any[];
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

const peerDeviceName = document.getElementById('peerDeviceName')!;
const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');

const transferProgressCard = document.getElementById('transferProgressCard')!;
const currentFileName = document.getElementById('currentFileName')!;
const transferPercentage = document.getElementById('transferPercentage')!;
const transferBytes = document.getElementById('transferBytes')!;
const transferSpeed = document.getElementById('transferSpeed')!;
const progressBar = document.getElementById('progressBar')!;
const transferDoneBox = document.getElementById('transferDoneBox')!;
const downloadBtn = document.getElementById('downloadBtn') as HTMLAnchorElement;
const fileList = document.getElementById('fileList')!;

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
    width: 172,
    margin: 0,
    color: {
      dark: '#090d16',
      light: '#ffffff'
    }
  });
}

// -------------------------------------------------------------
// SCREEN WAKE LOCK
// -------------------------------------------------------------
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await (navigator as any).wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch (_) {
    // Wake Lock not supported or battery saving active
  }
}

// -------------------------------------------------------------
// PEERJS CLOUD SIGNALING (Reliable WebRTC P2P)
// -------------------------------------------------------------
function initPeer() {
  connectionStatus.textContent = 'Connecting to signaling network...';

  const fullId = `${PEER_PREFIX}${myPin}`;
  peer = new Peer(fullId, {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', () => {
    connectionStatus.textContent = 'Scan QR code or enter PIN on your other device';
    if (statusPill) statusPill.className = 'status-pill online';
    if (statusText) statusText.textContent = 'Online';

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
    reliable: true
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
// FILE SENDER (Buffered Backpressure Streaming)
// -------------------------------------------------------------
async function sendFile(file: File) {
  if (!activeConnection || !activeConnection.open) {
    alert('Please wait for device connection!');
    return;
  }

  activeConnection.send(createFileHeader(file.name, file.size, file.type));
  showProgressCard(file.name, file.size, false);

  let offset = 0;
  const startTime = Date.now();
  const dc: RTCDataChannel | undefined = activeConnection.dataChannel;

  if (dc) {
    dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
  }

  while (offset < file.size) {
    // Strict backpressure wait loop: ensures buffer in flight NEVER exceeds MAX_BUFFER_THRESHOLD
    if (dc) {
      while (shouldWaitBackpressure(dc.bufferedAmount, MAX_BUFFER_THRESHOLD)) {
        await new Promise<void>((resolve) => {
          let resolved = false;
          const onLow = () => {
            if (!resolved) {
              resolved = true;
              dc.removeEventListener('bufferedamountlow', onLow);
              resolve();
            }
          };
          dc.addEventListener('bufferedamountlow', onLow);
          setTimeout(onLow, 25);
        });
      }
    }

    const chunkSlice = file.slice(offset, offset + DEFAULT_CHUNK_SIZE);
    const buffer = await chunkSlice.arrayBuffer();

    activeConnection.send(buffer);

    offset += buffer.byteLength;
    updateTransferProgress(offset, file.size, startTime);
  }

  setTimeout(() => {
    if (activeConnection && activeConnection.open) {
      activeConnection.send(createDoneSignal());
      addHistoryItem(file.name, file.size, 'sent');
    }
  }, 100);
}

// -------------------------------------------------------------
// FILE RECEIVER
// -------------------------------------------------------------
async function handleIncomingData(data: any) {
  if (isControlMessage(data)) {
    if (data.type === 'header') {
      currentIncomingFile = {
        name: data.name,
        size: data.size,
        type: data.mimeType || 'application/octet-stream',
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

  if (currentIncomingFile) {
    let chunk = parseIncomingChunk(data);
    if (!chunk && typeof Blob !== 'undefined' && data instanceof Blob) {
      const arr = await data.arrayBuffer();
      chunk = new Uint8Array(arr);
    }

    if (chunk) {
      currentIncomingFile.chunks.push(chunk);
      currentIncomingFile.receivedBytes += chunk.byteLength;
      updateTransferProgress(
        currentIncomingFile.receivedBytes,
        currentIncomingFile.size,
        currentIncomingFile.startTime
      );
    }
  }
}

function completeIncomingFile(file: IncomingFile) {
  const blob = new Blob(file.chunks as BlobPart[], { type: file.type || 'application/octet-stream' });
  const objectUrl = URL.createObjectURL(blob);

  transferDoneBox.classList.remove('hidden');
  downloadBtn.href = objectUrl;
  downloadBtn.download = file.name;

  // Auto trigger download for mobile Safari & Android Chrome
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = file.name;
  document.body.appendChild(a);
  setTimeout(() => {
    a.click();
    document.body.removeChild(a);
  }, 100);

  addHistoryItem(file.name, file.size, 'received', objectUrl);
}

// -------------------------------------------------------------
// UI HELPERS
// -------------------------------------------------------------
function updateTransferProgress(loaded: number, total: number, startTime: number) {
  const p = calculateProgress(loaded, total, startTime);
  progressBar.style.width = `${p.percent}%`;
  transferPercentage.textContent = `${p.percent}%`;
  transferBytes.textContent = `${p.formattedLoaded} / ${p.formattedTotal}`;
  transferSpeed.textContent = p.speedMBs;
}

function showProgressCard(name: string, _size: number, isReceiving: boolean) {
  transferProgressCard.classList.remove('hidden');
  transferDoneBox.classList.add('hidden');
  currentFileName.textContent = `${isReceiving ? 'Receiving: ' : 'Sending: '} ${name}`;
  progressBar.style.width = '0%';
  transferPercentage.textContent = '0%';
  transferBytes.textContent = '';
  transferSpeed.textContent = '';
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
  const empty = fileList.querySelector('.empty-list');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'history-item';
  item.innerHTML = `
    <span>${mode === 'sent' ? '↑' : '↓'} <strong>${name}</strong> <small style="color: var(--text-dim); margin-left: 0.4rem">(${formatBytes(size)})</small></span>
    ${downloadUrl ? `<a href="${downloadUrl}" download="${name}" class="btn-save" style="font-size: 0.78rem; padding: 0.3rem 0.7rem;">Save</a>` : ''}
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        <span>Copy Link</span>
      `;
    }, 2000);
  });

  disconnectBtn?.addEventListener('click', () => {
    activeConnection?.close();
    resetToPairingView('Disconnected.');
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target !== fileInput) {
      fileInput.click();
    }
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
      fileInput.value = '';
    }
  });
}

// -------------------------------------------------------------
// 3D NEON PARTICLE & CONSTELLATION BACKGROUND
// -------------------------------------------------------------
function initBackgroundParticles() {
  const canvas = document.getElementById('bgParticles') as HTMLCanvasElement;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = (canvas.width = window.innerWidth);
  let height = (canvas.height = window.innerHeight);

  window.addEventListener('resize', () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  });

  const particleCount = Math.min(width < 600 ? 35 : 65, 80);
  const particles: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
    color: string;
    alpha: number;
  }> = [];

  const colors = ['#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

  for (let i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.7,
      vy: (Math.random() - 0.5) * 0.7,
      size: Math.random() * 2.5 + 1,
      color: colors[Math.floor(Math.random() * colors.length)],
      alpha: Math.random() * 0.6 + 0.2
    });
  }

  function animate() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0) p.x = width;
      if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height;
      if (p.y > height) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.shadowBlur = 10;
      ctx.shadowColor = p.color;
      ctx.fill();

      for (let j = i + 1; j < particles.length; j++) {
        const p2 = particles[j];
        const dx = p.x - p2.x;
        const dy = p.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = (1 - dist / 120) * 0.22;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }

    ctx.globalAlpha = 1.0;
    ctx.shadowBlur = 0;
    requestAnimationFrame(animate);
  }

  animate();
}

// Start app
init();
initBackgroundParticles();
