const archiveList = document.getElementById('archiveList');
const listHead = document.getElementById('listHead');
const quotaEl = document.getElementById('quota');
const uploadForm = document.getElementById('uploadForm');
const uploadStatus = document.getElementById('uploadStatus');
const serverProgress = document.getElementById('serverProgress');
const uploadEta = document.getElementById('uploadEta');
const logoutBtn = document.getElementById('logoutBtn');
const adminLink = document.getElementById('adminLink');
const uploadArea = document.getElementById('uploadArea');
const folderInput = document.getElementById('folderInput');
const uploadFolderBtn = document.getElementById('uploadFolderBtn');
const listTitle = document.getElementById('listTitle');
const folderPriorityWrap = document.getElementById('folderPriorityWrap');
const folderPrioritySelect = document.getElementById('folderPrioritySelect');
const folderPrioritySave = document.getElementById('folderPrioritySave');
const searchInput = document.getElementById('searchInput');
const newFolderBtn = document.getElementById('newFolderBtn');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
const navFiles = document.getElementById('navFiles');
const navShared = document.getElementById('navShared');
const navTrash = document.getElementById('navTrash');
const sidebar = document.querySelector('.sidebar');

const contextMenu = document.getElementById('contextMenu');
const infoModal = document.getElementById('infoModal');
const infoTitle = document.getElementById('infoTitle');
const infoBody = document.getElementById('infoBody');
const infoClose = document.getElementById('infoClose');
const previewModal = document.getElementById('previewModal');
const previewTitle = document.getElementById('previewTitle');
const previewState = document.getElementById('previewState');
const previewText = document.getElementById('previewText');
const previewImage = document.getElementById('previewImage');
const previewFrame = document.getElementById('previewFrame');
const previewClose = document.getElementById('previewClose');

const deleteModal = document.getElementById('deleteModal');
const deleteCancelBtn = document.getElementById('deleteCancelBtn');
const deleteConfirmBtn = document.getElementById('deleteConfirmBtn');
const deleteSkipConfirm = document.getElementById('deleteSkipConfirm');

const shareModal = document.getElementById('shareModal');
const shareModalTitle = document.getElementById('shareModalTitle');
const shareExpirySelect = document.getElementById('shareExpirySelect');
const shareExpiryCustom = document.getElementById('shareExpiryCustom');
const shareCreateBtn = document.getElementById('shareCreateBtn');
const shareCopyBtn = document.getElementById('shareCopyBtn');
const shareCloseBtn = document.getElementById('shareCloseBtn');
const shareResult = document.getElementById('shareResult');

const priorityModal = document.getElementById('priorityModal');
const priorityTitle = document.getElementById('priorityTitle');
const prioritySelect = document.getElementById('prioritySelect');
const prioritySaveBtn = document.getElementById('prioritySaveBtn');
const priorityCloseBtn = document.getElementById('priorityCloseBtn');

let currentFolderId = null;
let currentView = 'files'; // files | trash | shared
let STREAM_UPLOADS_ENABLED = false;
let STREAM_SINGLE_MIN_MIB = 8;
let UI_REFRESH_MS = 5000;
let UI_ETA_WINDOW_MS = 120000;
let UI_ETA_MAX_SAMPLES = 30;
let dragArchiveId = null;
let dragFolderId = null;
let foldersById = {};
let foldersCache = [];
let archivesCache = [];
let searchTerm = '';
let selectedItems = new Map();
let lastSelectedIndex = null;
let lastRenderedItems = [];
let pendingDeleteResolve = null;
let shareTarget = null;
let priorityTarget = null;
const ROOT_DROP = '__root__';
let dropUploadFolderId = null;
const archiveProgress = new Map();
let previewObjectUrl = null;
const thumbImageExt = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif']);
const thumbVideoExt = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.wmv', '.flv', '.mpeg', '.mpg', '.ts', '.m2ts', '.3gp', '.ogv', '.vob']);
const thumbFailureUntil = new Map();
const THUMB_RETRY_MS = 2 * 60 * 1000;

const priorities = [
  { value: 0, label: 'lowest' },
  { value: 1, label: 'low' },
  { value: 2, label: 'normal' },
  { value: 3, label: 'high' },
  { value: 4, label: 'maximum' }
];

function updateUrl() {
  const params = new URLSearchParams();
  if (currentView !== 'files') {
    params.set('view', currentView);
  }
  if (currentView === 'files' && currentFolderId) {
    params.set('folder', currentFolderId);
  }
  if (searchTerm) {
    params.set('search', searchTerm);
  }
  const qs = params.toString();
  const url = qs ? `${location.pathname}?${qs}` : location.pathname;
  history.replaceState({}, '', url);
}

async function loadMe() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    location.href = '/';
    return null;
  }
  const me = await res.json();
  adminLink.style.display = me.role === 'admin' ? 'inline' : 'none';
  const usedGb = (me.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const quotaGb = me.quotaBytes > 0 ? (me.quotaBytes / (1024 * 1024 * 1024)).toFixed(2) : 'unlimited';
  quotaEl.textContent = `Used: ${usedGb} GB / Quota: ${quotaGb} GB`;
  return me;
}

function discordProgress(archive) {
  const pct = processedPercent(archive);
  return `${pct}%`;
}

function processedTotalBytes(archive) {
  const encrypted = Number(archive.encryptedSize || 0);
  if (encrypted > 0) return encrypted;
  const original = Number(archive.originalSize || 0);
  if (original > 0) return original;
  const uploaded = Number(archive.uploadedBytes || 0);
  return uploaded > 0 ? uploaded : 0;
}

function processedPercent(archive) {
  if (archive.status === 'ready') return 100;
  const total = processedTotalBytes(archive);
  if (total <= 0) return 0;
  const uploaded = Number(archive.uploadedBytes || 0);
  return Math.max(0, Math.min(99, Math.floor((uploaded / total) * 100)));
}

function deleteProgress(archive) {
  if (!archive.deleteTotalParts || archive.deleteTotalParts === 0) return '0%';
  const pct = Math.min(100, Math.floor((archive.deletedParts / archive.deleteTotalParts) * 100));
  return `${pct}%`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}h ${String(mins).padStart(2, '0')}m`;
  }
  if (mins > 0) {
    return `${mins}m ${String(secs).padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

function updateArchiveProgress(archives) {
  const now = Date.now();
  const activeIds = new Set();
  const maxWindowMs = UI_ETA_WINDOW_MS;
  const maxSamples = UI_ETA_MAX_SAMPLES;

  for (const archive of archives) {
    activeIds.add(archive._id);
    const entry = archiveProgress.get(archive._id) || { lastBytes: 0, lastTs: 0, speed: 0, samples: [] };
    const uploaded = Number(archive.uploadedBytes || 0);

    entry.samples.push({ ts: now, bytes: uploaded });
    entry.samples = entry.samples.filter((s) => now - s.ts <= maxWindowMs);
    if (entry.samples.length > maxSamples) {
      entry.samples = entry.samples.slice(entry.samples.length - maxSamples);
    }

    if (entry.samples.length >= 2) {
      const first = entry.samples[0];
      const last = entry.samples[entry.samples.length - 1];
      const deltaBytes = last.bytes - first.bytes;
      const deltaTime = (last.ts - first.ts) / 1000;
      if (deltaTime > 0 && deltaBytes >= 0) {
        const windowSpeed = deltaBytes / deltaTime;
        entry.speed = entry.speed ? (entry.speed * 0.7 + windowSpeed * 0.3) : windowSpeed;
      }
    }

    entry.lastBytes = uploaded;
    entry.lastTs = now;
    if (archive.status === 'ready') {
      entry.speed = 0;
    }
    archiveProgress.set(archive._id, entry);
  }
  for (const id of archiveProgress.keys()) {
    if (!activeIds.has(id)) {
      archiveProgress.delete(id);
    }
  }
}

function buildFolderPath(folderId) {
  if (!folderId || !foldersById[folderId]) return 'Files';
  const parts = [];
  let current = foldersById[folderId];
  while (current) {
    parts.unshift(current.name);
    const parentId = current.parentId ? current.parentId.toString() : null;
    current = parentId ? foldersById[parentId] : null;
  }
  return `Files / ${parts.join(' / ')}`;
}

function updateTitle() {
  if (currentView === 'trash') {
    listTitle.textContent = 'Trash';
  } else if (currentView === 'shared') {
    listTitle.textContent = 'Shared';
  } else {
    listTitle.textContent = buildFolderPath(currentFolderId);
  }
  updateViewVisibility();
  updateUrl();
}

function priorityLabel(value) {
  const item = priorities.find((p) => p.value === value);
  return item ? item.label : 'normal';
}

function fileExtension(name) {
  if (!name) return '';
  const lower = String(name).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

function supportsThumb(name) {
  const ext = fileExtension(name);
  return thumbImageExt.has(ext) || thumbVideoExt.has(ext);
}

function createFileIconElement() {
  const fileIcon = document.createElement('span');
  fileIcon.className = 'file-icon';
  return fileIcon;
}

function shouldLoadThumb(archiveId, fileIndex) {
  const key = `${archiveId}:${fileIndex}`;
  const retryAt = Number(thumbFailureUntil.get(key) || 0);
  if (retryAt > Date.now()) {
    return false;
  }
  thumbFailureUntil.delete(key);
  return true;
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
}

function syncSidebarHeight() {
  if (!sidebar) return;
  if (window.matchMedia('(max-width: 900px)').matches) {
    sidebar.style.height = 'auto';
    return;
  }
  const top = sidebar.getBoundingClientRect().top;
  const minTop = 20;
  const bottomPad = 20;
  const available = Math.floor(window.innerHeight - Math.max(top, minTop) - bottomPad);
  sidebar.style.height = `${Math.max(220, available)}px`;
}

function showContextMenu(x, y, items) {
  contextMenu.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.addEventListener('click', async () => {
      hideContextMenu();
      await item.onClick?.();
    });
    contextMenu.appendChild(btn);
  }
  contextMenu.classList.remove('hidden');
  const rect = contextMenu.getBoundingClientRect();
  const margin = 8;
  let posX = x;
  let posY = y;
  if (posX + rect.width + margin > window.innerWidth) {
    posX = window.innerWidth - rect.width - margin;
  }
  if (posY + rect.height + margin > window.innerHeight) {
    posY = window.innerHeight - rect.height - margin;
  }
  if (posX < margin) posX = margin;
  if (posY < margin) posY = margin;
  contextMenu.style.left = `${posX}px`;
  contextMenu.style.top = `${posY}px`;
}

function showInfoModal(title, rows) {
  infoTitle.textContent = title;
  infoBody.innerHTML = '';
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'info-row';
    const key = document.createElement('div');
    key.className = 'info-key';
    key.textContent = row.label;
    const value = document.createElement('div');
    value.className = 'info-value';
    value.textContent = row.value;
    line.appendChild(key);
    line.appendChild(value);
    infoBody.appendChild(line);
  }
  infoModal.classList.remove('hidden');
}

function resetPreviewContent(message) {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  previewState.textContent = message || '';
  previewState.classList.remove('hidden');
  previewText.classList.add('hidden');
  previewImage.classList.add('hidden');
  previewFrame.classList.add('hidden');
  previewText.textContent = '';
  previewImage.removeAttribute('src');
  previewFrame.removeAttribute('src');
}

function closePreviewModal() {
  previewModal.classList.add('hidden');
  resetPreviewContent('');
}

async function openPreviewModal(item) {
  const archive = item.archive;
  const fileName = item.file?.originalName || item.file?.name || archive.displayName || archive.name;
  previewTitle.textContent = `Preview: ${fileName}`;
  resetPreviewContent('Loading preview...');
  previewModal.classList.remove('hidden');

  let url = `/api/archives/${archive._id}/preview`;
  if (item.isBundle) {
    url += `?fileIndex=${item.fileIndex}`;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 413) {
        resetPreviewContent('File is too large for preview');
      } else if (res.status === 415) {
        resetPreviewContent('Preview is not supported for this file type');
      } else if (res.status === 409) {
        resetPreviewContent('File is not ready yet');
      } else {
        resetPreviewContent('Failed to load preview');
      }
      return;
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const blob = await res.blob();

    if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')) {
      previewText.textContent = await blob.text();
      previewState.classList.add('hidden');
      previewText.classList.remove('hidden');
      return;
    }

    previewObjectUrl = URL.createObjectURL(blob);
    previewState.classList.add('hidden');

    if (contentType.startsWith('image/')) {
      previewImage.src = previewObjectUrl;
      previewImage.classList.remove('hidden');
      return;
    }

    if (contentType === 'application/pdf') {
      previewFrame.src = previewObjectUrl;
      previewFrame.classList.remove('hidden');
      return;
    }

    resetPreviewContent('Preview is not supported for this file type');
  } catch (err) {
    resetPreviewContent('Failed to load preview');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    prompt('Copy to clipboard:', text);
  }
}

function setActiveNav() {
  navFiles.classList.toggle('active', currentView === 'files');
  navShared.classList.toggle('active', currentView === 'shared');
  navTrash.classList.toggle('active', currentView === 'trash');
  if (currentView !== 'files') {
    folderPriorityWrap.style.display = 'none';
  }
}

function getChildFolders(parentId) {
  return foldersCache.filter((f) => {
    const pid = f.parentId ? f.parentId.toString() : null;
    return pid === parentId;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function renderHead() {
  if (currentView === 'shared') {
    listHead.innerHTML = `
      <tr>
        <th>Name</th>
        <th>Type</th>
        <th>Expires</th>
        <th>Link</th>
        <th>Actions</th>
      </tr>
    `;
    return;
  }

  listHead.innerHTML = `
    <tr>
      <th>Name</th>
      <th>Status</th>
      <th>Processed</th>
      <th>Downloads</th>
      <th>Priority</th>
      <th>Date</th>
      <th>Size</th>
      <th>Actions</th>
    </tr>
  `;
}

async function loadFolders() {
  const res = await fetch('/api/folders');
  const data = await res.json();
  foldersCache = data.folders || [];
  foldersById = {};
  for (const f of foldersCache) {
    foldersById[f._id] = f;
  }

  if (currentView === 'files' && currentFolderId) {
    if (!foldersById[currentFolderId]) {
      currentFolderId = null;
    }
    const folder = foldersById[currentFolderId];
    if (folder) {
      folderPrioritySelect.value = String(folder.priority ?? 2);
      folderPriorityWrap.style.display = 'flex';
    }
  } else {
    folderPriorityWrap.style.display = 'none';
  }
  updateTitle();
}

function buildFileItems(archives) {
  const items = [];
  for (const archive of archives) {
    const files = archive.files || [];
    if (archive.isBundle && files.length > 1) {
      files.forEach((file, index) => {
        items.push({ archive, file, fileIndex: index, isBundle: true });
      });
    } else {
      items.push({ archive, file: files[0], fileIndex: 0, isBundle: false });
    }
  }
  return items;
}

function filterItems(items) {
  if (!searchTerm) return items;
  const query = searchTerm.toLowerCase();
  return items.filter((item) => {
    const name = (item.file?.originalName || item.file?.name || item.archive.displayName || item.archive.name || '').toLowerCase();
    return name.includes(query);
  });
}

function getDownloadUrl(item) {
  if (item.isBundle) {
    return `/api/archives/${item.archive._id}/files/${item.fileIndex}/download`;
  }
  return `/api/archives/${item.archive._id}/download`;
}

async function loadArchives() {
  if (currentView === 'shared') {
    await loadShared();
    return;
  }

  const params = new URLSearchParams();
  if (currentView === 'trash') {
    params.set('trash', '1');
  } else if (!currentFolderId) {
    params.set('root', '1');
  } else if (currentFolderId) {
    params.set('folderId', currentFolderId);
  }
  const res = await fetch(`/api/archives?${params.toString()}`);
  const data = await res.json();
  archivesCache = data.archives || [];
  updateArchiveProgress(archivesCache);
  renderArchives();
}

function renderFoldersInList() {
  const children = getChildFolders(currentFolderId);
  if (!currentFolderId) {
    return children;
  }
  return children;
}

function renderArchives() {
  archiveList.innerHTML = '';
  renderHead();
  updateSelectionUI();

  if (currentView === 'shared') return;

  if (currentView === 'files') {
    if (currentFolderId) {
      const current = foldersById[currentFolderId];
      const parentId = current?.parentId ? current.parentId.toString() : null;
      const trUp = document.createElement('tr');
      trUp.className = 'folder-row-item';
      const nameTd = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'folder-row';
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      const text = document.createElement('span');
      text.textContent = '..';
      wrap.appendChild(icon);
      wrap.appendChild(text);
      nameTd.appendChild(wrap);
      nameTd.colSpan = 8;
      trUp.appendChild(nameTd);
      trUp.addEventListener('click', () => {
        currentFolderId = parentId;
        selectedItems.clear();
        updateTitle();
        loadFolders();
        loadArchives();
      });
      trUp.addEventListener('dragover', (e) => {
        e.stopPropagation();
        if (dragFolderId || dragArchiveId) {
          e.preventDefault();
          trUp.classList.add('drop');
          return;
        }
        if (isFileDrag(e)) {
          e.preventDefault();
          trUp.classList.add('drop');
          dropUploadFolderId = parentId ?? ROOT_DROP;
        }
      });
      trUp.addEventListener('dragleave', () => {
        trUp.classList.remove('drop');
        if (dropUploadFolderId === parentId || (parentId === null && dropUploadFolderId === ROOT_DROP)) {
          dropUploadFolderId = null;
        }
      });
      trUp.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        trUp.classList.remove('drop');
        if (dragFolderId) {
          await fetch(`/api/folders/${dragFolderId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentId })
          });
          dragFolderId = null;
          loadFolders();
          loadArchives();
          return;
        }
        if (dragArchiveId) {
          await fetch(`/api/archives/${dragArchiveId}/move`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId: parentId })
          });
          dragArchiveId = null;
          loadArchives();
          return;
        }
        if (isFileDrag(e)) {
          const files = e.dataTransfer.files;
          if (files && files.length > 0) {
            await uploadFiles(files, parentId ?? null);
          }
          dropUploadFolderId = null;
        }
      });
      archiveList.appendChild(trUp);
    }

    const folders = renderFoldersInList();
    for (const folder of folders) {
      const tr = document.createElement('tr');
      tr.className = 'folder-row-item';
      tr.draggable = true;
      tr.addEventListener('dragstart', () => { dragFolderId = folder._id; });
      tr.addEventListener('dragend', () => { dragFolderId = null; });
      tr.addEventListener('click', () => {
        currentFolderId = folder._id;
        selectedItems.clear();
        updateTitle();
        loadFolders();
        loadArchives();
      });
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openFolderContextMenu(folder, e.clientX, e.clientY);
      });

      tr.addEventListener('dragover', (e) => {
        e.stopPropagation();
        if (dragFolderId || dragArchiveId) {
          e.preventDefault();
          tr.classList.add('drop');
          return;
        }
        if (isFileDrag(e)) {
          e.preventDefault();
          tr.classList.add('drop');
          dropUploadFolderId = folder._id;
        }
      });
      tr.addEventListener('dragleave', () => {
        tr.classList.remove('drop');
        if (dropUploadFolderId === folder._id) {
          dropUploadFolderId = null;
        }
      });
      tr.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        tr.classList.remove('drop');
        if (dragFolderId) {
          if (dragFolderId === folder._id) {
            dragFolderId = null;
            return;
          }
          await fetch(`/api/folders/${dragFolderId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentId: folder._id })
          });
          dragFolderId = null;
          loadFolders();
          loadArchives();
          return;
        }
        if (dragArchiveId) {
          await fetch(`/api/archives/${dragArchiveId}/move`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId: folder._id })
          });
          dragArchiveId = null;
          loadArchives();
          return;
        }
        if (isFileDrag(e)) {
          const files = e.dataTransfer.files;
          if (files && files.length > 0) {
            await uploadFiles(files, folder._id);
          }
          dropUploadFolderId = null;
        }
      });

      const nameTd = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'folder-row';
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      const text = document.createElement('span');
      text.textContent = folder.name;
      wrap.appendChild(icon);
      wrap.appendChild(text);
      nameTd.appendChild(wrap);
      nameTd.colSpan = 8;
      tr.appendChild(nameTd);
      archiveList.appendChild(tr);
    }
  }

  const items = filterItems(buildFileItems(archivesCache));
  lastRenderedItems = items;
  for (const [index, item] of items.entries()) {
    const a = item.archive;
    const key = `${a._id}:${item.fileIndex}`;
    const tr = document.createElement('tr');
    tr.draggable = currentView !== 'trash';
    tr.dataset.archiveId = a._id;
    tr.dataset.fileIndex = String(item.fileIndex ?? 0);
    if (selectedItems.has(key)) {
      tr.classList.add('row-selected');
    }
    tr.addEventListener('dragstart', () => { dragArchiveId = a._id; });
    tr.addEventListener('dragend', () => { dragArchiveId = null; });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openFileContextMenu(item, e.clientX, e.clientY);
    });
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button,select')) return;
      handleRowSelection(item, key, index, e);
    });

    const nameTd = document.createElement('td');
    const nameWrap = document.createElement('div');
    nameWrap.className = 'name-cell';
    const fileName = item.file?.originalName || item.file?.name || a.displayName || a.name;
    let iconEl;
    if (supportsThumb(fileName) && shouldLoadThumb(a._id, item.fileIndex)) {
      const thumb = document.createElement('img');
      thumb.className = 'thumb-icon';
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.src = `/api/archives/${a._id}/files/${item.fileIndex}/thumbnail`;
      thumb.onerror = () => {
        thumbFailureUntil.set(`${a._id}:${item.fileIndex}`, Date.now() + THUMB_RETRY_MS);
        if (thumb.parentElement) {
          thumb.replaceWith(createFileIconElement());
        }
      };
      thumb.onload = () => {
        thumbFailureUntil.delete(`${a._id}:${item.fileIndex}`);
      };
      iconEl = thumb;
    } else {
      iconEl = createFileIconElement();
    }
    const nameText = document.createElement('span');
    nameText.textContent = fileName;
    nameWrap.appendChild(iconEl);
    nameWrap.appendChild(nameText);
    if (item.isBundle) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = 'bundle';
      nameWrap.appendChild(pill);
    }
    nameTd.appendChild(nameWrap);
    if (a.files && a.files.length > 0) {
      nameTd.title = a.files.map((f) => f.originalName || f.name).join(', ');
    }

    const statusTd = document.createElement('td');
    if (currentView === 'trash' && (a.deleting || a.deleteRequestedAt)) {
      statusTd.textContent = `deleting ${deleteProgress(a)}`;
    } else {
      statusTd.textContent = a.status;
    }

    const discordTd = document.createElement('td');
    const progressWrap = document.createElement('div');
    progressWrap.className = 'mini-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'mini-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'mini-bar-fill';
    const totalBytes = processedTotalBytes(a);
    const uploadedBytes = Number(a.uploadedBytes || 0);
    const pct = processedPercent(a);
    progressFill.style.width = `${pct}%`;
    progressBar.appendChild(progressFill);
    const progressMeta = document.createElement('div');
    progressMeta.className = 'mini-meta';
    const entry = archiveProgress.get(a._id);
    let etaText = '';
    if (a.status !== 'ready' && totalBytes > 0 && uploadedBytes < totalBytes && entry?.speed) {
      const remaining = totalBytes - uploadedBytes;
      const eta = formatDuration(remaining / entry.speed);
      if (eta) etaText = `ETA ${eta}`;
    }
    progressMeta.textContent = a.status === 'ready'
      ? '100%'
      : `${pct}%${etaText ? ` | ${etaText}` : ''}`;
    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressMeta);
    discordTd.appendChild(progressWrap);

    const downloadsTd = document.createElement('td');
    const downloadCount = (item.file && typeof item.file.downloadCount === 'number')
      ? item.file.downloadCount
      : 0;
    downloadsTd.textContent = String(downloadCount);

    const priorityTd = document.createElement('td');
    const prioritySelect = document.createElement('select');
    for (const p of priorities) {
      const opt = document.createElement('option');
      opt.value = String(p.value);
      opt.textContent = p.label;
      prioritySelect.appendChild(opt);
    }
    prioritySelect.value = String(a.priority ?? 2);
    if (currentView === 'trash') {
      prioritySelect.disabled = true;
    }
    prioritySelect.addEventListener('change', async () => {
      await fetch(`/api/archives/${a._id}/priority`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: Number(prioritySelect.value) })
      });
    });
    priorityTd.appendChild(prioritySelect);

    const dateTd = document.createElement('td');
    dateTd.textContent = formatDate(a.createdAt);

    const sizeTd = document.createElement('td');
    const sizeValue = item.file?.size ?? a.originalSize;
    sizeTd.textContent = formatSize(sizeValue);

    const actionTd = document.createElement('td');
    if (currentView === 'trash') {
      const restoreBtn = document.createElement('button');
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', async () => {
        await fetch(`/api/archives/${a._id}/restore`, { method: 'POST' });
        loadArchives();
      });
      const purgeBtn = document.createElement('button');
      purgeBtn.textContent = 'Delete Forever';
      purgeBtn.addEventListener('click', async () => {
        await fetch(`/api/archives/${a._id}/purge`, { method: 'POST' });
        loadArchives();
      });
      actionTd.appendChild(restoreBtn);
      actionTd.appendChild(purgeBtn);
    } else {
      if (a.status === 'ready') {
        const link = document.createElement('a');
        link.href = getDownloadUrl(item);
        link.textContent = 'Download';
        actionTd.appendChild(link);
      }
      const delBtn = document.createElement('button');
      delBtn.textContent = item.isBundle ? 'Delete Bundle' : 'Delete';
      delBtn.addEventListener('click', async () => {
        const ok = await confirmDelete();
        if (!ok) return;
        await fetch(`/api/archives/${a._id}/trash`, { method: 'POST' });
        loadArchives();
      });
      actionTd.appendChild(delBtn);
    }

    tr.appendChild(nameTd);
    tr.appendChild(statusTd);
    tr.appendChild(discordTd);
    tr.appendChild(downloadsTd);
    tr.appendChild(priorityTd);
    tr.appendChild(dateTd);
    tr.appendChild(sizeTd);
    tr.appendChild(actionTd);

    archiveList.appendChild(tr);
  }
}

function updateSelectionUI() {
  const isFiles = currentView === 'files';
  downloadSelectedBtn.disabled = selectedItems.size === 0 || !isFiles;
  downloadSelectedBtn.classList.toggle('hidden', !isFiles);
  deleteSelectedBtn.disabled = selectedItems.size === 0 || !isFiles;
  deleteSelectedBtn.classList.toggle('hidden', !isFiles);
  newFolderBtn.classList.toggle('hidden', !isFiles);
}

function updateViewVisibility() {
  uploadArea.classList.toggle('hidden', currentView !== 'files');
  folderPriorityWrap.style.display = currentView === 'files' && currentFolderId ? 'flex' : 'none';
}

function handleRowSelection(item, key, index, event) {
  const isShift = event.shiftKey;
  const isCtrl = event.ctrlKey || event.metaKey;

  if (isShift && lastSelectedIndex !== null) {
    const start = Math.min(lastSelectedIndex, index);
    const end = Math.max(lastSelectedIndex, index);
    if (!isCtrl) {
      selectedItems.clear();
    }
    for (let i = start; i <= end; i += 1) {
      const it = lastRenderedItems[i];
      if (!it) continue;
      const k = `${it.archive._id}:${it.fileIndex}`;
      selectedItems.set(k, { archiveId: it.archive._id, fileIndex: it.fileIndex });
    }
  } else if (isCtrl) {
    if (selectedItems.has(key)) {
      selectedItems.delete(key);
    } else {
      selectedItems.set(key, { archiveId: item.archive._id, fileIndex: item.fileIndex });
    }
  } else {
    selectedItems.clear();
    selectedItems.set(key, { archiveId: item.archive._id, fileIndex: item.fileIndex });
  }

  lastSelectedIndex = index;
  renderArchives();
}

async function uploadFiles(fileList, targetFolderId) {
  if (!fileList || fileList.length === 0) return;
  uploadStatus.textContent = 'Uploading to server...';
  serverProgress.value = 0;
  uploadEta.textContent = '';
  let startTime = 0;
  let lastTime = 0;
  let lastLoaded = 0;
  let lastSpeed = 0;

  const data = new FormData();
  let folderId = targetFolderId === undefined ? currentFolderId : targetFolderId;
  if (!folderId && currentView === 'files') {
    const params = new URLSearchParams(location.search);
    folderId = params.get('folder');
  }
  if (folderId) {
    data.append('folderId', folderId);
  }
  const fileEntries = Array.from(fileList);
  const hasRelative = fileEntries.some((file) => file.webkitRelativePath);
  for (const file of fileEntries) {
    data.append('files', file);
    data.append('names', file.name);
    if (hasRelative && file.webkitRelativePath) {
      data.append('paths', file.webkitRelativePath);
    }
  }

  const streamSingle = STREAM_UPLOADS_ENABLED && fileList.length === 1 && fileList[0].size >= (STREAM_SINGLE_MIN_MIB * 1024 * 1024);
  let uploadUrl = streamSingle ? '/api/upload-stream' : '/api/upload';
  if (streamSingle) {
    const params = new URLSearchParams();
    if (folderId) {
      params.set('folderId', folderId);
    }
    if (hasRelative && fileEntries[0]?.webkitRelativePath) {
      params.set('path', fileEntries[0].webkitRelativePath);
    }
    const query = params.toString();
    if (query) {
      uploadUrl += `?${query}`;
    }
  }

  const xhr = new XMLHttpRequest();
  xhr.open('POST', uploadUrl);
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      const now = Date.now();
      if (!startTime) startTime = now;
      const pct = Math.floor((event.loaded / event.total) * 100);
      serverProgress.value = pct;
      const deltaBytes = event.loaded - lastLoaded;
      const deltaTime = (now - (lastTime || now)) / 1000;
      if (deltaTime > 0 && deltaBytes >= 0) {
        const instant = deltaBytes / deltaTime;
        lastSpeed = lastSpeed ? (lastSpeed * 0.7 + instant * 0.3) : instant;
      }
      lastLoaded = event.loaded;
      lastTime = now;
      const avgSpeed = event.loaded / Math.max(1, (now - startTime) / 1000);
      const speed = lastSpeed || avgSpeed;
      const remaining = Math.max(0, event.total - event.loaded);
      const eta = speed > 0 ? formatDuration(remaining / speed) : '';
      uploadStatus.textContent = `Uploading to server... ${pct}% (${formatSize(event.loaded)} / ${formatSize(event.total)})`;
      uploadEta.textContent = eta ? `ETA ${eta}` : '';
    }
  };

  xhr.onload = async () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      uploadStatus.textContent = 'Queued for processing';
      serverProgress.value = 100;
      uploadEta.textContent = '';
      uploadForm.reset();
      await loadMe();
      await loadFolders();
      await loadArchives();
    } else {
      let err = 'upload_failed';
      try {
        const data = JSON.parse(xhr.responseText);
        err = data.error || err;
      } catch (e) {}
      uploadStatus.textContent = `Error: ${err}`;
      uploadEta.textContent = '';
    }
  };

  xhr.onerror = () => {
    uploadStatus.textContent = 'Upload failed';
    uploadEta.textContent = '';
  };

  xhr.send(data);
}

async function setArchivePriority(archiveId, value) {
  await fetch(`/api/archives/${archiveId}/priority`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: value })
  });
  loadArchives();
}

async function setFolderPriority(folderId, value) {
  await fetch(`/api/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: value })
  });
  loadFolders();
  loadArchives();
}

async function openFolderContextMenu(folder, x, y) {
  const items = [
    { label: 'Open', onClick: async () => {
      currentView = 'files';
      currentFolderId = folder._id;
      setActiveNav();
      updateTitle();
      loadFolders();
      loadArchives();
    } },
    { label: 'New subfolder', onClick: async () => {
      const name = prompt('Folder name');
      if (!name) return;
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId: folder._id })
      });
      if (!res.ok) {
        alert('Folder already exists');
        return;
      }
      loadFolders();
      loadArchives();
    } },
    { label: 'Rename', onClick: async () => {
      const name = prompt('New folder name', folder.name);
      if (!name || name.trim() === folder.name) return;
      const res = await fetch(`/api/folders/${folder._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() })
      });
      if (!res.ok) {
        alert('Folder already exists');
        return;
      }
      loadFolders();
      updateTitle();
    } },
    { label: 'Folder info', onClick: async () => {
      const res = await fetch(`/api/folders/${folder._id}/info`);
      if (!res.ok) return;
      const info = await res.json();
      showInfoModal(`Folder: ${folder.name}`, [
        { label: 'Total size', value: formatSize(info.totalSize) },
        { label: 'Archives', value: String(info.totalArchives) },
        { label: 'Files', value: String(info.totalFiles) },
        { label: 'Parts', value: String(info.totalParts || 0) }
      ]);
    } },
    { label: 'Delete folder', onClick: async () => {
      const ok = await confirmDelete();
      if (!ok) return;
      await fetch(`/api/folders/${folder._id}`, { method: 'DELETE' });
      if (currentFolderId === folder._id) {
        currentFolderId = folder.parentId ? folder.parentId.toString() : null;
      }
      selectedItems.clear();
      loadFolders();
      loadArchives();
    } },
    { label: 'Download folder', onClick: async () => { location.href = `/api/folders/${folder._id}/download`; } },
    { label: 'Share', onClick: async () => openShareModal({ type: 'folder', id: folder._id, name: folder.name }) },
    { label: 'Copy name', onClick: async () => copyText(folder.name) },
    { label: 'Priority...', onClick: async () => openPriorityModal({ type: 'folder', id: folder._id, name: folder.name, value: folder.priority ?? 2 }) }
  ];
  showContextMenu(x, y, items);
}

async function openFileContextMenu(item, x, y) {
  const a = item.archive;
  const fileName = item.file?.originalName || item.file?.name || a.displayName || a.name;
  const downloadUrl = getDownloadUrl(item);
  const bundleUrl = `/api/archives/${a._id}/download`;
  const key = `${a._id}:${item.fileIndex}`;
  if (!selectedItems.has(key)) {
    selectedItems.clear();
    selectedItems.set(key, { archiveId: a._id, fileIndex: item.fileIndex });
    lastSelectedIndex = lastRenderedItems.findIndex((it) => `${it.archive._id}:${it.fileIndex}` === key);
    renderArchives();
  }
  const items = [];

  if (selectedItems.size > 1) {
    items.push({ label: `Download selected (${selectedItems.size})`, onClick: async () => submitDownloadSelected() });
    items.push({ label: `Delete selected (${selectedItems.size})`, onClick: async () => {
      const ok = await confirmDelete();
      if (!ok) return;
      const archiveIds = new Set(Array.from(selectedItems.values()).map((it) => it.archiveId));
      await Promise.all(Array.from(archiveIds).map((id) => fetch(`/api/archives/${id}/trash`, { method: 'POST' })));
      selectedItems.clear();
      await loadArchives();
    } });
  }

  if (a.status === 'ready') {
    const label = selectedItems.size > 1 ? 'Download this file' : 'Download';
    items.push({ label, onClick: async () => { location.href = downloadUrl; } });
  } else {
    items.push({ label: 'Download', disabled: true });
  }

  items.push({
    label: 'Preview',
    disabled: a.status !== 'ready',
    onClick: async () => openPreviewModal(item)
  });

  if (item.isBundle && a.status === 'ready') {
    items.push({ label: 'Download bundle', onClick: async () => { location.href = bundleUrl; } });
  }

  items.push({ label: 'Share', onClick: async () => openShareModal({ type: 'archive', id: a._id, name: fileName }) });
  items.push({ label: 'Rename', onClick: async () => {
    const nextName = prompt('New name', fileName);
    if (!nextName) return;
    const payload = { name: nextName };
    if (item.isBundle) {
      payload.fileIndex = item.fileIndex;
    }
    await fetch(`/api/archives/${a._id}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    loadArchives();
  } });
  items.push({ label: 'Copy name', onClick: async () => copyText(fileName) });
  items.push({
    label: 'Copy download link',
    disabled: a.status !== 'ready',
    onClick: async () => copyText(`${location.origin}${downloadUrl}`)
  });

  items.push({ label: 'Info', onClick: async () => {
    const partsCount = (typeof a.totalParts === 'number' && a.totalParts > 0)
      ? a.totalParts
      : (Array.isArray(a.parts) ? a.parts.length : 0);
    showInfoModal(`File: ${fileName}`, [
      { label: 'Status', value: a.status },
      { label: 'Processed', value: a.status === 'ready' ? '100%' : discordProgress(a) },
      { label: 'Downloads', value: String((item.file && typeof item.file.downloadCount === 'number') ? item.file.downloadCount : 0) },
      { label: 'Parts', value: String(partsCount) },
      { label: 'Size', value: formatSize(item.file?.size ?? a.originalSize) },
      { label: 'Created', value: formatDate(a.createdAt) },
      { label: 'Priority', value: priorityLabel(a.priority ?? 2) },
      { label: 'Folder', value: a.folderId ? buildFolderPath(a.folderId) : 'All Files' }
    ]);
  } });

  items.push({ label: 'Priority...', onClick: async () => openPriorityModal({ type: 'archive', id: a._id, name: fileName, value: a.priority ?? 2 }) });

  if (currentView === 'trash') {
    items.push({ label: 'Restore', onClick: async () => {
      await fetch(`/api/archives/${a._id}/restore`, { method: 'POST' });
      loadArchives();
    } });
    items.push({ label: 'Delete forever', onClick: async () => {
      await fetch(`/api/archives/${a._id}/purge`, { method: 'POST' });
      loadArchives();
    } });
  } else {
    items.push({ label: item.isBundle ? 'Delete bundle' : 'Delete', onClick: async () => {
      const ok = await confirmDelete();
      if (!ok) return;
      await fetch(`/api/archives/${a._id}/trash`, { method: 'POST' });
      loadArchives();
    } });
  }

  showContextMenu(x, y, items);
}

async function confirmDelete() {
  if (localStorage.getItem('skipDeleteConfirm') === 'true') {
    return true;
  }
  deleteModal.classList.remove('hidden');
  deleteSkipConfirm.checked = false;
  return new Promise((resolve) => {
    pendingDeleteResolve = resolve;
  });
}

function closeDeleteModal(result) {
  deleteModal.classList.add('hidden');
  if (deleteSkipConfirm.checked) {
    localStorage.setItem('skipDeleteConfirm', 'true');
  }
  if (pendingDeleteResolve) {
    pendingDeleteResolve(result);
    pendingDeleteResolve = null;
  }
}

function openShareModal(target) {
  shareTarget = target;
  shareModalTitle.textContent = `Share ${target.name}`;
  shareExpirySelect.value = 'never';
  shareExpiryCustom.classList.add('hidden');
  shareResult.textContent = '';
  shareCopyBtn.classList.add('hidden');
  shareModal.classList.remove('hidden');
}

function closeShareModal() {
  shareModal.classList.add('hidden');
  shareTarget = null;
}

function openPriorityModal(target) {
  priorityTarget = target;
  priorityTitle.textContent = `Priority: ${target.name}`;
  prioritySelect.value = String(target.value ?? 2);
  priorityModal.classList.remove('hidden');
}

function closePriorityModal() {
  priorityModal.classList.add('hidden');
  priorityTarget = null;
}

async function savePriority() {
  if (!priorityTarget) return;
  const value = Number(prioritySelect.value);
  if (priorityTarget.type === 'archive') {
    await setArchivePriority(priorityTarget.id, value);
  } else {
    await setFolderPriority(priorityTarget.id, value);
  }
  closePriorityModal();
}

function computeExpiry() {
  const now = new Date();
  switch (shareExpirySelect.value) {
    case '1d':
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    case '1w':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    case '1m':
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    case 'custom':
      if (shareExpiryCustom.value) {
        return new Date(shareExpiryCustom.value);
      }
      return null;
    default:
      return null;
  }
}

async function createShareLink() {
  if (!shareTarget) return;
  const expiry = computeExpiry();
  const payload = shareTarget.type === 'archive'
    ? { archiveId: shareTarget.id, expiresAt: expiry ? expiry.toISOString() : null }
    : { folderId: shareTarget.id, expiresAt: expiry ? expiry.toISOString() : null };
  const res = await fetch('/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    shareResult.textContent = 'Failed to create link';
    return;
  }
  const data = await res.json();
  const link = `${location.origin}/share/${data.token}`;
  shareResult.textContent = link;
  shareCopyBtn.dataset.link = link;
  shareCopyBtn.classList.remove('hidden');
}

async function loadShared() {
  const res = await fetch('/api/shares?active=1');
  const data = await res.json();
  archiveList.innerHTML = '';
  renderHead();
  updateSelectionUI();
  const shares = data.shares || [];
  for (const share of shares) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = share.name || 'Shared';
    const typeTd = document.createElement('td');
    typeTd.textContent = share.type;
    const expTd = document.createElement('td');
    expTd.textContent = share.expiresAt ? formatDate(share.expiresAt) : 'Never';
    const linkTd = document.createElement('td');
    const link = `${location.origin}/share/${share.token}`;
    const linkEl = document.createElement('a');
    linkEl.href = link;
    linkEl.textContent = 'Open';
    linkTd.appendChild(linkEl);
    const actionTd = document.createElement('td');
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy link';
    copyBtn.addEventListener('click', async () => copyText(link));
    const revokeBtn = document.createElement('button');
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', async () => {
      await fetch(`/api/shares/${share.id}`, { method: 'DELETE' });
      loadShared();
    });
    actionTd.appendChild(copyBtn);
    actionTd.appendChild(revokeBtn);

    tr.appendChild(nameTd);
    tr.appendChild(typeTd);
    tr.appendChild(expTd);
    tr.appendChild(linkTd);
    tr.appendChild(actionTd);
    archiveList.appendChild(tr);
  }
}

function submitDownloadSelected() {
  if (selectedItems.size === 0) return;
  const items = Array.from(selectedItems.values());
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/archives/download-zip';
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'payload';
  input.value = JSON.stringify({ items });
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

navFiles.addEventListener('click', () => {
  currentView = 'files';
  currentFolderId = null;
  selectedItems.clear();
  setActiveNav();
  updateTitle();
  loadFolders();
  loadArchives();
});

navShared.addEventListener('click', () => {
  currentView = 'shared';
  currentFolderId = null;
  selectedItems.clear();
  setActiveNav();
  updateTitle();
  loadArchives();
});

navTrash.addEventListener('click', () => {
  currentView = 'trash';
  currentFolderId = null;
  selectedItems.clear();
  setActiveNav();
  updateTitle();
  loadArchives();
});

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = uploadForm.querySelector('input[type="file"]');
  await uploadFiles(input.files);
});

uploadFolderBtn.addEventListener('click', () => {
  folderInput.click();
});

folderInput.addEventListener('change', async () => {
  await uploadFiles(folderInput.files);
  folderInput.value = '';
});

function isFileDrag(e) {
  const types = Array.from(e.dataTransfer?.types || []);
  return types.includes('Files');
}

document.addEventListener('dragover', (e) => {
  if (dragArchiveId || dragFolderId) return;
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (!e.target.closest('.folder-row-item')) {
    dropUploadFolderId = null;
  }
  uploadArea.classList.add('drop');
});

document.addEventListener('dragleave', (e) => {
  if (dragArchiveId || dragFolderId) return;
  if (!isFileDrag(e)) return;
  uploadArea.classList.remove('drop');
  if (!e.target.closest('.folder-row-item')) {
    dropUploadFolderId = null;
  }
});

document.addEventListener('drop', async (e) => {
  if (dragArchiveId || dragFolderId) return;
  if (!isFileDrag(e)) return;
  e.preventDefault();
  uploadArea.classList.remove('drop');
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    const target = dropUploadFolderId === ROOT_DROP ? null : dropUploadFolderId;
    await uploadFiles(files, target);
  }
  dropUploadFolderId = null;
});

newFolderBtn.addEventListener('click', async () => {
  if (currentView !== 'files') return;
  const name = prompt('Folder name');
  if (!name) return;
  const payload = { name, parentId: currentFolderId };
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    alert('Folder already exists');
    return;
  }
  loadFolders();
  loadArchives();
});

downloadSelectedBtn.addEventListener('click', () => {
  submitDownloadSelected();
});

deleteSelectedBtn.addEventListener('click', async () => {
  if (selectedItems.size === 0) return;
  const ok = await confirmDelete();
  if (!ok) return;
  const archiveIds = new Set(Array.from(selectedItems.values()).map((item) => item.archiveId));
  await Promise.all(Array.from(archiveIds).map((id) => fetch(`/api/archives/${id}/trash`, { method: 'POST' })));
  selectedItems.clear();
  await loadArchives();
});

folderPrioritySave.addEventListener('click', async () => {
  if (!currentFolderId) return;
  await fetch(`/api/folders/${currentFolderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: Number(folderPrioritySelect.value) })
  });
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/';
});

searchInput.addEventListener('input', () => {
  searchTerm = searchInput.value.trim();
  updateUrl();
  renderArchives();
});

infoClose.addEventListener('click', () => {
  infoModal.classList.add('hidden');
});

infoModal.addEventListener('click', (e) => {
  if (e.target === infoModal) {
    infoModal.classList.add('hidden');
  }
});

previewClose.addEventListener('click', () => closePreviewModal());
previewModal.addEventListener('click', (e) => {
  if (e.target === previewModal) {
    closePreviewModal();
  }
});

deleteCancelBtn.addEventListener('click', () => closeDeleteModal(false));
deleteConfirmBtn.addEventListener('click', () => closeDeleteModal(true));

deleteModal.addEventListener('click', (e) => {
  if (e.target === deleteModal) {
    closeDeleteModal(false);
  }
});

shareCloseBtn.addEventListener('click', () => closeShareModal());
shareCreateBtn.addEventListener('click', createShareLink);
shareCopyBtn.addEventListener('click', async () => {
  const link = shareCopyBtn.dataset.link;
  if (link) {
    await copyText(link);
  }
});
shareExpirySelect.addEventListener('change', () => {
  if (shareExpirySelect.value === 'custom') {
    shareExpiryCustom.classList.remove('hidden');
  } else {
    shareExpiryCustom.classList.add('hidden');
  }
});

shareModal.addEventListener('click', (e) => {
  if (e.target === shareModal) {
    closeShareModal();
  }
});

priorityCloseBtn.addEventListener('click', () => closePriorityModal());
prioritySaveBtn.addEventListener('click', savePriority);
priorityModal.addEventListener('click', (e) => {
  if (e.target === priorityModal) {
    closePriorityModal();
  }
});

document.addEventListener('click', () => hideContextMenu());
document.addEventListener('scroll', () => hideContextMenu());
window.addEventListener('resize', () => {
  hideContextMenu();
  syncSidebarHeight();
});
window.addEventListener('scroll', () => syncSidebarHeight(), { passive: true });

(async () => {
  try {
    const res = await fetch('/api/ui-config');
    if (res.ok) {
      const cfg = await res.json();
      if (typeof cfg.streamUploadsEnabled === 'boolean') {
        STREAM_UPLOADS_ENABLED = cfg.streamUploadsEnabled;
      }
      if (typeof cfg.streamSingleMinMiB === 'number') {
        STREAM_SINGLE_MIN_MIB = cfg.streamSingleMinMiB;
      }
      if (typeof cfg.refreshMs === 'number') {
        UI_REFRESH_MS = cfg.refreshMs;
      }
      if (typeof cfg.etaWindowMs === 'number') {
        UI_ETA_WINDOW_MS = cfg.etaWindowMs;
      }
      if (typeof cfg.etaMaxSamples === 'number') {
        UI_ETA_MAX_SAMPLES = cfg.etaMaxSamples;
      }
    }
  } catch (err) {}
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const folder = params.get('folder');
  const search = params.get('search');
  if (view === 'trash' || view === 'shared' || view === 'files') {
    currentView = view;
  }
  if (currentView === 'files' && folder) {
    currentFolderId = folder;
  }
  if (search) {
    searchTerm = search;
    searchInput.value = search;
  }
  setActiveNav();
  updateTitle();
  await loadMe();
  await loadFolders();
  await loadArchives();
  syncSidebarHeight();
  setInterval(loadArchives, UI_REFRESH_MS);
})();
