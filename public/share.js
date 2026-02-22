const shareTitle = document.getElementById('shareTitle');
const shareMeta = document.getElementById('shareMeta');
const shareActions = document.getElementById('shareActions');
const shareHead = document.getElementById('shareHead');
const shareList = document.getElementById('shareList');

const sharePreviewModal = document.getElementById('sharePreviewModal');
const sharePreviewTitle = document.getElementById('sharePreviewTitle');
const sharePreviewState = document.getElementById('sharePreviewState');
const sharePreviewText = document.getElementById('sharePreviewText');
const sharePreviewImage = document.getElementById('sharePreviewImage');
const sharePreviewVideo = document.getElementById('sharePreviewVideo');
const sharePreviewAudio = document.getElementById('sharePreviewAudio');
const sharePreviewFrame = document.getElementById('sharePreviewFrame');
const sharePreviewClose = document.getElementById('sharePreviewClose');

const thumbImageExt = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif']);
const thumbVideoExt = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.wmv', '.flv', '.mpeg', '.mpg', '.ts', '.m2ts', '.3gp', '.ogv', '.vob']);
const thumbFailureUntil = new Map();
const THUMB_RETRY_MS = 2 * 60 * 1000;
let shareToken = '';
let previewObjectUrl = null;

function formatDate(iso) {
  if (!iso) return 'Never';
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

function isTextLikeContentType(contentType) {
  if (!contentType) return false;
  if (contentType.startsWith('text/')) return true;
  const base = contentType.split(';')[0].trim();
  return [
    'application/json',
    'application/xml',
    'text/xml',
    'application/javascript',
    'application/typescript',
    'application/x-javascript',
    'text/x-python',
    'application/x-python-code',
    'text/x-php',
    'application/x-httpd-php',
    'text/x-c',
    'text/x-c++src',
    'text/x-java-source',
    'text/x-go',
    'text/x-rustsrc',
    'application/sql',
    'application/yaml',
    'text/yaml',
    'text/x-yaml',
    'application/x-sh'
  ].includes(base);
}

function renderHead() {
  shareHead.innerHTML = `
    <tr>
      <th>Name</th>
      <th>Size</th>
      <th>Date</th>
      <th>Actions</th>
    </tr>
  `;
}

function resetPreviewContent(message) {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  sharePreviewState.textContent = message || '';
  sharePreviewState.classList.remove('hidden');
  sharePreviewText.classList.add('hidden');
  sharePreviewImage.classList.add('hidden');
  sharePreviewVideo.classList.add('hidden');
  sharePreviewAudio.classList.add('hidden');
  sharePreviewFrame.classList.add('hidden');
  sharePreviewText.textContent = '';
  sharePreviewImage.removeAttribute('src');
  sharePreviewVideo.pause();
  sharePreviewVideo.removeAttribute('src');
  sharePreviewAudio.pause();
  sharePreviewAudio.removeAttribute('src');
  sharePreviewFrame.removeAttribute('src');
}

function closePreviewModal() {
  sharePreviewModal.classList.add('hidden');
  resetPreviewContent('');
}

async function openPreviewModal(item) {
  sharePreviewTitle.textContent = `Preview: ${item.name}`;
  resetPreviewContent('Loading preview...');
  sharePreviewModal.classList.remove('hidden');

  try {
    const res = await fetch(item.previewUrl);
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

    if (isTextLikeContentType(contentType)) {
      sharePreviewText.textContent = await blob.text();
      sharePreviewState.classList.add('hidden');
      sharePreviewText.classList.remove('hidden');
      return;
    }

    previewObjectUrl = URL.createObjectURL(blob);
    sharePreviewState.classList.add('hidden');

    if (contentType.startsWith('image/')) {
      sharePreviewImage.src = previewObjectUrl;
      sharePreviewImage.classList.remove('hidden');
      return;
    }

    if (contentType.startsWith('video/')) {
      sharePreviewVideo.src = previewObjectUrl;
      sharePreviewVideo.classList.remove('hidden');
      return;
    }

    if (contentType.startsWith('audio/')) {
      sharePreviewAudio.src = previewObjectUrl;
      sharePreviewAudio.classList.remove('hidden');
      return;
    }

    if (contentType === 'application/pdf') {
      sharePreviewFrame.src = previewObjectUrl;
      sharePreviewFrame.classList.remove('hidden');
      return;
    }

    resetPreviewContent('Preview is not supported for this file type');
  } catch {
    resetPreviewContent('Failed to load preview');
  }
}

function addRow(item) {
  const tr = document.createElement('tr');
  const nameTd = document.createElement('td');
  const sizeTd = document.createElement('td');
  const dateTd = document.createElement('td');
  const actionTd = document.createElement('td');

  const nameWrap = document.createElement('div');
  nameWrap.className = 'name-cell';
  let iconEl = null;
  if (item.thumbUrl && supportsThumb(item.name) && shouldLoadThumb(item.archiveId, item.fileIndex)) {
    const thumb = document.createElement('img');
    thumb.className = 'thumb-icon';
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.src = item.thumbUrl;
    thumb.onerror = () => {
      thumbFailureUntil.set(`${item.archiveId}:${item.fileIndex}`, Date.now() + THUMB_RETRY_MS);
      if (thumb.parentElement) {
        thumb.replaceWith(createFileIconElement());
      }
    };
    thumb.onload = () => {
      thumbFailureUntil.delete(`${item.archiveId}:${item.fileIndex}`);
    };
    iconEl = thumb;
  } else {
    iconEl = createFileIconElement();
  }
  const nameText = document.createElement('span');
  nameText.textContent = item.name;
  nameWrap.appendChild(iconEl);
  nameWrap.appendChild(nameText);
  if (item.isBundle) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = 'bundle';
    nameWrap.appendChild(pill);
  }
  nameTd.appendChild(nameWrap);

  sizeTd.textContent = formatSize(item.size);
  dateTd.textContent = item.date ? new Date(item.date).toLocaleString() : '';

  if (item.downloadUrl) {
    const link = document.createElement('a');
    link.href = item.downloadUrl;
    link.textContent = 'Download';
    actionTd.appendChild(link);
  } else if (item.status) {
    actionTd.textContent = item.status;
  }

  const previewBtn = document.createElement('button');
  previewBtn.textContent = 'Preview';
  previewBtn.disabled = !item.previewUrl;
  previewBtn.addEventListener('click', async () => openPreviewModal(item));
  actionTd.appendChild(previewBtn);

  tr.appendChild(nameTd);
  tr.appendChild(sizeTd);
  tr.appendChild(dateTd);
  tr.appendChild(actionTd);
  shareList.appendChild(tr);
}

async function loadShare() {
  const parts = location.pathname.split('/');
  shareToken = parts[parts.length - 1] || parts[parts.length - 2];
  const res = await fetch(`/api/public/shares/${shareToken}`);
  if (!res.ok) {
    shareTitle.textContent = 'Link expired or not found';
    return;
  }
  const data = await res.json();
  renderHead();
  shareTitle.textContent = data.name || 'Shared link';
  shareMeta.textContent = `Expires: ${formatDate(data.expiresAt)}`;
  shareActions.innerHTML = '';
  shareList.innerHTML = '';

  if (data.type === 'archive') {
    const downloadUrl = `/api/public/shares/${shareToken}/download`;
    const button = document.createElement('a');
    button.href = downloadUrl;
    button.textContent = 'Download full';
    shareActions.appendChild(button);

    const archive = data.archive;
    if (archive?.isBundle && archive.files?.length) {
      archive.files.forEach((file, index) => {
        const isReady = archive.status === 'ready';
        addRow({
          archiveId: String(archive.id),
          fileIndex: index,
          isBundle: true,
          name: file.originalName || file.name,
          size: file.size,
          date: archive.createdAt,
          status: archive.status,
          downloadUrl: isReady ? `/api/public/shares/${shareToken}/download?fileIndex=${index}` : null,
          thumbUrl: isReady ? `/api/public/shares/${shareToken}/archive/${archive.id}/files/${index}/thumbnail` : null,
          previewUrl: isReady ? `/api/public/shares/${shareToken}/archive/${archive.id}/preview?fileIndex=${index}` : null
        });
      });
    } else if (archive) {
      const isReady = archive.status === 'ready';
      const file = archive.files?.[0] || {};
      addRow({
        archiveId: String(archive.id),
        fileIndex: 0,
        isBundle: false,
        name: archive.name || data.name,
        size: archive.originalSize,
        date: archive.createdAt,
        status: archive.status,
        downloadUrl: isReady ? downloadUrl : null,
        thumbUrl: isReady ? `/api/public/shares/${shareToken}/archive/${archive.id}/files/0/thumbnail` : null,
        previewUrl: isReady ? `/api/public/shares/${shareToken}/archive/${archive.id}/preview?fileIndex=0` : null,
        fileName: file.originalName || file.name
      });
    }
    return;
  }

  if (data.type === 'folder') {
    const archives = data.archives || [];
    for (const archive of archives) {
      if (archive.isBundle && archive.files?.length) {
        archive.files.forEach((file, index) => {
          const isReady = archive.status === 'ready';
          addRow({
            archiveId: String(archive.id),
            fileIndex: index,
            isBundle: true,
            name: file.originalName || file.name,
            size: file.size,
            date: archive.createdAt,
            status: archive.status,
            downloadUrl: isReady
              ? `/api/public/shares/${shareToken}/archive/${archive.id}/download?fileIndex=${index}`
              : null,
            thumbUrl: isReady
              ? `/api/public/shares/${shareToken}/archive/${archive.id}/files/${index}/thumbnail`
              : null,
            previewUrl: isReady
              ? `/api/public/shares/${shareToken}/archive/${archive.id}/preview?fileIndex=${index}`
              : null
          });
        });
      } else {
        const isReady = archive.status === 'ready';
        addRow({
          archiveId: String(archive.id),
          fileIndex: 0,
          isBundle: false,
          name: archive.name,
          size: archive.originalSize,
          date: archive.createdAt,
          status: archive.status,
          downloadUrl: isReady ? `/api/public/shares/${shareToken}/archive/${archive.id}/download` : null,
          thumbUrl: isReady ? `/api/public/shares/${shareToken}/archive/${archive.id}/files/0/thumbnail` : null,
          previewUrl: isReady ? `/api/public/shares/${shareToken}/archive/${archive.id}/preview?fileIndex=0` : null
        });
      }
    }
  }
}

sharePreviewClose.addEventListener('click', () => closePreviewModal());
sharePreviewModal.addEventListener('click', (e) => {
  if (e.target === sharePreviewModal) {
    closePreviewModal();
  }
});

loadShare();
