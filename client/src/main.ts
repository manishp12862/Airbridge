import QRCode from 'qrcode';

declare const Peer: any;

const PEER_PREFIX = 'airbridge-v1-';
const CHUNK_SIZE  = 16 * 1024;

let myPin       = generateRandomPin();
let peer: any   = null;
let activeConn: any = null;

interface IncomingFile {
  name: string; size: number; mimeType: string;
  receivedBytes: number; chunks: ArrayBuffer[]; startTime: number;
}
let incomingFile: IncomingFile | null = null;

const pairingSection        = document.getElementById('pairingSection')!;
const transferSection       = document.getElementById('transferSection')!;
const myPinEl               = document.getElementById('myPin')!;
const qrCanvas              = document.getElementById('qrCanvas') as HTMLCanvasElement;
const joinForm              = document.getElementById('joinForm') as HTMLFormElement;
const joinInput             = document.getElementById('joinInput') as HTMLInputElement;
const connectionStatus      = document.getElementById('connectionStatus')!;
const copyLinkBtn           = document.getElementById('copyLinkBtn')!;
const disconnectBtn         = document.getElementById('disconnectBtn')!;
const dropZone              = document.getElementById('dropZone')!;
const fileInput             = document.getElementById('fileInput') as HTMLInputElement;
const peerDeviceName        = document.getElementById('peerDeviceName')!;
const statusPill            = document.getElementById('statusPill')!;
const statusText            = document.getElementById('statusText')!;
const transferProgressCard  = document.getElementById('transferProgressCard')!;
const currentFileName       = document.getElementById('currentFileName')!;
const transferPercentage    = document.getElementById('transferPercentage')!;
const transferBytes         = document.getElementById('transferBytes')!;
const transferSpeed         = document.getElementById('transferSpeed')!;
const progressBar           = document.getElementById('progressBar')!;
const transferDoneBox       = document.getElementById('transferDoneBox')!;
const downloadBtn           = document.getElementById('downloadBtn') as HTMLAnchorElement;
const fileList              = document.getElementById('fileList')!;

function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam && roomParam.length === 4) joinInput.value = roomParam;
  myPinEl.textContent = myPin;
  generateQRCode();
  setupEventListeners();
  initPeer();
}

function generateRandomPin(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateQRCode() {
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${myPin}`;
  QRCode.toCanvas(qrCanvas, shareUrl, { width: 196, margin: 0, color: { dark: '#090d16', light: '#ffffff' } });
}

function initPeer() {
  connectionStatus.textContent = 'Connecting to network...';
  peer = new Peer(`${PEER_PREFIX}${myPin}`, {
    debug: 0,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }
  });

  peer.on('open', () => {
    statusPill.className = 'status-pill online';
    statusText.textContent = 'Online';
    connectionStatus.textContent = 'Scan QR code or enter PIN on your other device';
    const roomParam = new URLSearchParams(window.location.search).get('room');
    if (roomParam && roomParam !== myPin) connectToPeer(roomParam);
  });

  peer.on('connection', (conn: any) => setupConnection(conn));

  peer.on('error', (err: any) => {
    if (err.type === 'unavailable-id') {
      myPin = generateRandomPin(); myPinEl.textContent = myPin; generateQRCode(); initPeer();
    } else if (err.type === 'peer-unavailable') {
      connectionStatus.textContent = 'PIN not found. Check the code!';
    } else {
      connectionStatus.textContent = `Error: ${err.type}`;
    }
  });
}

function connectToPeer(targetPin: string) {
  connectionStatus.textContent = `Connecting to ${targetPin}...`;
  setupConnection(peer.connect(`${PEER_PREFIX}${targetPin}`, { reliable: true, serialization: 'none' }));
}

function setupConnection(conn: any) {
  activeConn = conn;
  conn.on('open', () => {
    if (conn.dataChannel) conn.dataChannel.binaryType = 'arraybuffer';
    peerDeviceName.textContent = `Device (PIN ${conn.peer.replace(PEER_PREFIX, '')})`;
    showTransferView();
  });
  conn.on('data', (data: any) => onData(data));
  conn.on('close', () => resetToPairingView('Peer disconnected.'));
  conn.on('error', () => resetToPairingView('Connection error.'));
}

function onData(data: any) {
  if (typeof data === 'string') {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'header') {
        incomingFile = { name: msg.name, size: msg.size, mimeType: msg.mimeType || 'application/octet-stream', receivedBytes: 0, chunks: [], startTime: Date.now() };
        showProgressCard(msg.name, msg.size, true);
      } else if (msg.type === 'done' && incomingFile) {
        finaliseReceive(incomingFile); incomingFile = null;
      }
    } catch (_) {}
    return;
  }
  if (data instanceof ArrayBuffer && incomingFile) {
    incomingFile.chunks.push(data);
    incomingFile.receivedBytes += data.byteLength;
    updateProgress(incomingFile.receivedBytes, incomingFile.size, incomingFile.startTime);
  }
}

async function sendFile(file: File) {
  if (!activeConn || !activeConn.open) { alert('Not connected! Pair devices first.'); return; }
  const dc: RTCDataChannel = activeConn.dataChannel;
  activeConn.send(JSON.stringify({ type: 'header', name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' }));
  showProgressCard(file.name, file.size, false);
  dc.bufferedAmountLowThreshold = 64 * 1024;
  let offset = 0;
  const startTime = Date.now();
  while (offset < file.size) {
    if (dc.bufferedAmount > 256 * 1024) {
      await new Promise<void>((resolve) => {
        const onDrain = () => { dc.removeEventListener('bufferedamountlow', onDrain); resolve(); };
        dc.addEventListener('bufferedamountlow', onDrain);
        setTimeout(() => { dc.removeEventListener('bufferedamountlow', onDrain); resolve(); }, 40);
      });
    }
    const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    try { dc.send(buf); } catch (_) { await new Promise<void>((r) => setTimeout(r, 30)); continue; }
    offset += buf.byteLength;
    updateProgress(offset, file.size, startTime);
  }
  setTimeout(() => { activeConn.send(JSON.stringify({ type: 'done' })); addHistoryItem(file.name, file.size, 'sent'); }, 200);
}

function finaliseReceive(file: IncomingFile) {
  const blob = new Blob(file.chunks, { type: file.mimeType });
  const url  = URL.createObjectURL(blob);
  transferDoneBox.classList.remove('hidden');
  downloadBtn.href = url; downloadBtn.download = file.name;
  const a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a);
  setTimeout(() => { a.click(); document.body.removeChild(a); }, 100);
  addHistoryItem(file.name, file.size, 'received', url);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

function updateProgress(loaded: number, total: number, startTime: number) {
  const pct = Math.min(100, Math.round((loaded / total) * 100));
  const elapsed = (Date.now() - startTime) / 1000;
  const speed = elapsed > 0 ? loaded / elapsed : 0;
  progressBar.style.width = `${pct}%`;
  transferPercentage.textContent = `${pct}%`;
  transferBytes.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
  transferSpeed.textContent = `${(speed / 1048576).toFixed(1)} MB/s`;
}

function showProgressCard(name: string, _size: number, receiving: boolean) {
  transferProgressCard.classList.remove('hidden');
  transferDoneBox.classList.add('hidden');
  currentFileName.textContent = `${receiving ? 'Receiving' : 'Sending'}: ${name}`;
  progressBar.style.width = '0%'; transferPercentage.textContent = '0%';
  transferBytes.textContent = ''; transferSpeed.textContent = '';
}

function showTransferView() { pairingSection.classList.add('hidden'); transferSection.classList.remove('hidden'); }
function resetToPairingView(reason?: string) {
  pairingSection.classList.remove('hidden'); transferSection.classList.add('hidden');
  activeConn = null; if (reason) connectionStatus.textContent = reason;
}

function addHistoryItem(name: string, size: number, mode: 'sent' | 'received', url?: string) {
  fileList.querySelectorAll('.empty-list').forEach(e => e.remove());
  const item = document.createElement('div');
  item.className = 'history-item';
  item.innerHTML = `<span>${mode === 'sent' ? '↑' : '↓'} <strong>${name}</strong> <small>(${formatBytes(size)})</small></span>${url ? `<a href="${url}" download="${name}" class="btn-save" style="font-size:0.78rem;padding:0.3rem 0.7rem">Save</a>` : ''}`;
  fileList.prepend(item);
}

function setupEventListeners() {
  joinForm.addEventListener('submit', (e) => { e.preventDefault(); const pin = joinInput.value.trim(); if (pin.length === 4) connectToPeer(pin); });
  copyLinkBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?room=${myPin}`);
    copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => { copyLinkBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy Link</span>`; }, 2000);
  });
  disconnectBtn?.addEventListener('click', () => { activeConn?.close(); resetToPairingView('Disconnected.'); });
  dropZone.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); Array.from(e.dataTransfer?.files ?? []).forEach(f => sendFile(f)); });
  fileInput.addEventListener('change', () => { Array.from(fileInput.files ?? []).forEach(f => sendFile(f)); fileInput.value = ''; });
}

function initBackgroundParticles() {
  const canvas = document.getElementById('bgParticles') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  let W = (canvas.width = window.innerWidth), H = (canvas.height = window.innerHeight);
  window.addEventListener('resize', () => { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; });
  const colors = ['#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
  const pts = Array.from({ length: Math.min(W < 600 ? 35 : 60, 80) }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.65, vy: (Math.random() - 0.5) * 0.65,
    r: Math.random() * 2.2 + 0.8, color: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * 0.55 + 0.2
  }));
  (function loop() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]; p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; else if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; else if (p.y > H) p.y = 0;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color; ctx.globalAlpha = p.a; ctx.shadowBlur = 10; ctx.shadowColor = p.color; ctx.fill();
      for (let j = i + 1; j < pts.length; j++) {
        const q = pts[j], dx = p.x - q.x, dy = p.y - q.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 115) { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.strokeStyle = p.color; ctx.lineWidth = 0.75; ctx.globalAlpha = (1 - d / 115) * 0.2; ctx.stroke(); }
      }
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; requestAnimationFrame(loop);
  })();
}

init();
initBackgroundParticles();
