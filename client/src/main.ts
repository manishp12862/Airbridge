import QRCode from 'qrcode';

// -------------------------------------------------------------
// CONSTANTS & CONFIGURATION
// -------------------------------------------------------------
const CHUNK_SIZE = 64 * 1024; // 64 KB chunks: optimal for iOS Safari & Android WebRTC
const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB backpressure threshold to avoid crashing RAM

// Free public STUN servers for direct NAT traversal
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// -------------------------------------------------------------
// STATE
// -------------------------------------------------------------
let roomId = generateRandomPin();
let peerConnection: RTCPeerConnection | null = null;
let dataChannel: RTCDataChannel | null = null;
let ws: WebSocket | null = null;
let wakeLock: any = null;

// File Receiving Buffer State
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

// -------------------------------------------------------------
// INITIALIZATION
// -------------------------------------------------------------
function init() {
  // Check URL parameters for room code (?room=1234)
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam && roomParam.length === 4) {
    roomId = roomParam;
    joinInput.value = roomParam;
  }

  // Display Room PIN & Generate QR Code
  myPinEl.textContent = roomId;
  generateQRCode();

  // Setup Event Listeners
  setupEventListeners();

  // Connect to Signaling Server
  connectSignalingServer();

  // Request Screen Wake Lock (keeps iOS Safari awake during multi-gigabyte transfers)
  requestWakeLock();
}

function generateRandomPin(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateQRCode() {
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
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
// SCREEN WAKE LOCK (Crucial for iOS & Android)
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
// SIGNALING & WEBRTC
// -------------------------------------------------------------
function connectSignalingServer() {
  // Try local server first; fallback gracefully
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.hostname === 'localhost' 
    ? `localhost:9000` 
    : window.location.host;

  connectionStatus.textContent = 'Connecting to signaling network...';

  try {
    ws = new WebSocket(`${wsProtocol}//${wsHost}`);

    ws.onopen = () => {
      connectionStatus.textContent = `Joined room ${roomId}. Waiting for device...`;
      ws?.send(JSON.stringify({ type: 'join', roomId }));
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'joined':
          console.log('[AirBridge] Joined as initiator:', data.isInitiator);
          break;

        case 'peer_joined':
          connectionStatus.textContent = 'Peer detected! Establishing P2P link...';
          initiatePeerConnection();
          break;

        case 'signal':
          handleSignal(data.payload);
          break;

        case 'peer_disconnected':
          resetToPairingView('Remote peer disconnected.');
          break;

        case 'error':
          connectionStatus.textContent = data.message;
          break;
      }
    };

    ws.onerror = () => {
      connectionStatus.innerHTML = `⚠️ Signaling offline. (Run <code>npm run dev:server</code> or use LAN).`;
    };

    ws.onclose = () => {
      console.log('Signaling connection closed');
    };
  } catch (err) {
    console.error('Signaling connection failed', err);
  }
}

function initiatePeerConnection() {
  peerConnection = new RTCPeerConnection(RTC_CONFIG);

  // Setup ICE Candidates
  peerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      ws?.send(JSON.stringify({
        type: 'signal',
        roomId,
        payload: { candidate: e.candidate }
      }));
    }
  };

  // Create DataChannel (Initiator)
  dataChannel = peerConnection.createDataChannel('fileTransfer', {
    ordered: true
  });
  setupDataChannel(dataChannel);

  // Create & Send Offer
  peerConnection.createOffer().then((offer) => {
    peerConnection?.setLocalDescription(offer);
    ws?.send(JSON.stringify({
      type: 'signal',
      roomId,
      payload: { sdp: offer }
    }));
  });
}

async function handleSignal(payload: any) {
  if (payload.sdp) {
    if (!peerConnection) {
      peerConnection = new RTCPeerConnection(RTC_CONFIG);

      peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
          ws?.send(JSON.stringify({
            type: 'signal',
            roomId,
            payload: { candidate: e.candidate }
          }));
        }
      };

      peerConnection.ondatachannel = (e) => {
        dataChannel = e.channel;
        setupDataChannel(dataChannel);
      };
    }

    await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));

    if (payload.sdp.type === 'offer') {
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      ws?.send(JSON.stringify({
        type: 'signal',
        roomId,
        payload: { sdp: answer }
      }));
    }
  } else if (payload.candidate && peerConnection) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
  }
}

function setupDataChannel(channel: RTCDataChannel) {
  channel.binaryType = 'arraybuffer';

  channel.onopen = () => {
    showTransferView();
  };

  channel.onclose = () => {
    resetToPairingView('Connection closed.');
  };

  channel.onmessage = (event) => {
    handleIncomingData(event.data);
  };
}

// -------------------------------------------------------------
// HIGH-VOLUME 5-10 GB CHUNKED FILE SENDER (STREAMING)
// -------------------------------------------------------------
async function sendFile(file: File) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    alert('Please wait for device connection!');
    return;
  }

  // 1. Send file metadata header
  const header = {
    type: 'header',
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream'
  };
  dataChannel.send(JSON.stringify(header));

  // 2. Prepare UI
  showProgressCard(file.name, file.size, false);

  let offset = 0;
  const startTime = Date.now();

  // Stream slices directly into RTCDataChannel
  while (offset < file.size) {
    // Backpressure control: wait if buffer exceeds 1 MB so browser doesn't crash RAM
    if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!dataChannel || dataChannel.bufferedAmount < BUFFER_THRESHOLD / 2) {
            resolve();
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      });
    }

    const chunkSlice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await chunkSlice.arrayBuffer();
    dataChannel.send(buffer);

    offset += buffer.byteLength;
    updateProgress(offset, file.size, startTime);
  }

  // 3. Send transfer end signal
  dataChannel.send(JSON.stringify({ type: 'done' }));
  addHistoryItem(file.name, file.size, 'sent');
}

// -------------------------------------------------------------
// CHUNKED FILE RECEIVER
// -------------------------------------------------------------
function handleIncomingData(data: any) {
  if (typeof data === 'string') {
    const message = JSON.parse(data);

    if (message.type === 'header') {
      currentIncomingFile = {
        name: message.name,
        size: message.size,
        type: message.mimeType,
        receivedBytes: 0,
        chunks: [],
        startTime: Date.now()
      };
      showProgressCard(message.name, message.size, true);
    } else if (message.type === 'done') {
      if (currentIncomingFile) {
        completeIncomingFile(currentIncomingFile);
        currentIncomingFile = null;
      }
    }
    return;
  }

  // Raw Binary Chunk
  if (currentIncomingFile && data instanceof ArrayBuffer) {
    currentIncomingFile.chunks.push(data);
    currentIncomingFile.receivedBytes += data.byteLength;

    updateProgress(
      currentIncomingFile.receivedBytes,
      currentIncomingFile.size,
      currentIncomingFile.startTime
    );
  }
}

function completeIncomingFile(file: IncomingFile) {
  const blob = new Blob(file.chunks, { type: file.type });
  const objectUrl = URL.createObjectURL(blob);

  transferDoneBox.classList.remove('hidden');
  downloadBtn.href = objectUrl;
  downloadBtn.download = file.name;

  // Auto trigger download for mobile Safari & Android Chrome
  downloadBtn.click();

  addHistoryItem(file.name, file.size, 'received', objectUrl);
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
  // Join Room via PIN input
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = joinInput.value.trim();
    if (pin.length === 4) {
      roomId = pin;
      myPinEl.textContent = roomId;
      generateQRCode();
      ws?.send(JSON.stringify({ type: 'join', roomId }));
      connectionStatus.textContent = `Connecting to room ${roomId}...`;
    }
  });

  // Copy URL
  copyLinkBtn.addEventListener('click', async () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    await navigator.clipboard.writeText(shareUrl);
    copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyLinkBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Link
      `;
    }, 2000);
  });

  // Disconnect
  disconnectBtn.addEventListener('click', () => {
    peerConnection?.close();
    resetToPairingView('Disconnected.');
  });

  // File Dropzone
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

// Start
init();
