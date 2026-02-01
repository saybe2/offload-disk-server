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
const listTitle = document.getElementById('listTitle');
const folderPriorityWrap = document.getElementById('folderPriorityWrap');
const folderPrioritySelect = document.getElementById('folderPrioritySelect');
const folderPrioritySave = document.getElementById('folderPrioritySave');
const searchInput = document.getElementById('searchInput');
const newFolderBtn = document.getElementById('newFolderBtn');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const navFiles = document.getElementById('navFiles');
const navShared = document.getElementById('navShared');
const navTrash = document.getElementById('navTrash');

const contextMenu = document.getElementById('contextMenu');
const infoModal = document.getElementById('infoModal');
const infoTitle = document.getElementById('infoTitle');
const infoBody = document.getElementById('infoBody');
const infoClose = document.getElementById('infoClose');

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
let dragArchiveId = null;
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
const archiveProgress = new Map();

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
  if (!archive.encryptedSize) return '0%';
  const pct = Math.min(100, Math.floor((archive.uploadedBytes / archive.encryptedSize) * 100));
  return `${pct}%`;
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
  for (const archive of archives) {
    activeIds.add(archive._id);
    const entry = archiveProgress.get(archive._id) || { lastBytes: 0, lastTs: 0, speed: 0 };
    const uploaded = Number(archive.uploadedBytes || 0);
    if (entry.lastTs && uploaded >= entry.lastBytes) {
      const deltaBytes = uploaded - entry.lastBytes;
      const deltaTime = (now - entry.lastTs) / 1000;
      if (deltaTime > 0 && deltaBytes > 0) {
        const instant = deltaBytes / deltaTime;
        entry.speed = entry.speed ? (entry.speed * 0.7 + instant * 0.3) : instant;
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

function hideContextMenu() {
  contextMenu.classList.add('hidden');
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
      <th>Discord Upload</th>
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
      nameTd.colSpan = 7;
      trUp.appendChild(nameTd);
      trUp.addEventListener('click', () => {
        currentFolderId = parentId;
        selectedItems.clear();
        updateTitle();
        loadFolders();
        loadArchives();
      });
      archiveList.appendChild(trUp);
    }

    const folders = renderFoldersInList();
    for (const folder of folders) {
      const tr = document.createElement('tr');
      tr.className = 'folder-row-item';
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
        e.preventDefault();
        tr.classList.add('drop');
      });
      tr.addEventListener('dragleave', () => tr.classList.remove('drop'));
      tr.addEventListener('drop', async (e) => {
        e.preventDefault();
        tr.classList.remove('drop');
        if (!dragArchiveId) return;
        await fetch(`/api/archives/${dragArchiveId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId: folder._id })
        });
        dragArchiveId = null;
        loadArchives();
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
      nameTd.colSpan = 7;
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
    const fileIcon = document.createElement('span');
    fileIcon.className = 'file-icon';
    const fileName = item.file?.originalName || item.file?.name || a.displayName || a.name;
    const nameText = document.createElement('span');
    nameText.textContent = fileName;
    nameWrap.appendChild(fileIcon);
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
    const totalBytes = a.encryptedSize || 0;
    const uploadedBytes = a.uploadedBytes || 0;
    const pct = totalBytes > 0 ? Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100)) : 0;
    progressFill.style.width = `${a.status === 'ready' ? 100 : pct}%`;
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
      : `${pct}%${etaText ? ` · ${etaText}` : ''}`;
    progressWrap.appendChild(progressBar);
    progressWrap.appendChild(progressMeta);
    discordTd.appendChild(progressWrap);

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

async function uploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  uploadStatus.textContent = 'Uploading to server...';
  serverProgress.value = 0;
  uploadEta.textContent = '';
  let startTime = 0;
  let lastTime = 0;
  let lastLoaded = 0;
  let lastSpeed = 0;

  const data = new FormData();
  for (const file of fileList) {
    data.append('files', file);
  }
  if (currentFolderId) {
    data.append('folderId', currentFolderId);
  }

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
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
      uploadStatus.textContent = 'Queued for Discord upload';
      serverProgress.value = 100;
      uploadEta.textContent = '';
      uploadForm.reset();
      await loadMe();
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
        { label: 'Files', value: String(info.totalFiles) }
      ]);
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
  }

  if (a.status === 'ready') {
    const label = selectedItems.size > 1 ? 'Download this file' : 'Download';
    items.push({ label, onClick: async () => { location.href = downloadUrl; } });
  } else {
    items.push({ label: 'Download', disabled: true });
  }

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
    showInfoModal(`File: ${fileName}`, [
      { label: 'Status', value: a.status },
      { label: 'Discord upload', value: a.status === 'ready' ? '100%' : discordProgress(a) },
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

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('drop');
});

uploadArea.addEventListener('dragleave', () => {
  uploadArea.classList.remove('drop');
});

uploadArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  uploadArea.classList.remove('drop');
  const files = e.dataTransfer.files;
  await uploadFiles(files);
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
window.addEventListener('resize', () => hideContextMenu());

(async () => {
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
  setInterval(loadArchives, 5000);
})();
