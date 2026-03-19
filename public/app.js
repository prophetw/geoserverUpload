const STORAGE_KEY = 'geoserver-upload-ui:profiles:v1';
const SELECTED_PROFILE_KEY = 'geoserver-upload-ui:selected-profile:v1';

const fallbackMeta = {
  allowedSuffixes: [
    '.shp',
    '.shx',
    '.dbf',
    '.prj',
    '.cpg',
    '.sbn',
    '.sbx',
    '.qix',
    '.qpj',
    '.fix',
    '.aih',
    '.ain',
    '.shp.xml',
    '.qmd',
  ],
  requiredShapefileSuffixes: ['.shp', '.shx', '.dbf'],
};

const state = {
  meta: fallbackMeta,
  profiles: [],
  selectedProfileId: '',
  uploadFiles: new Map(),
  groups: [],
  ignoredFiles: [],
  isPublishing: false,
  isQuerying: false,
};

const elements = {
  profileCount: document.querySelector('#profileCount'),
  requiredSuffixes: document.querySelector('#requiredSuffixes'),
  profileSelect: document.querySelector('#profileSelect'),
  profileName: document.querySelector('#profileName'),
  geoserverUrl: document.querySelector('#geoserverUrl'),
  workspace: document.querySelector('#workspace'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  saveProfileButton: document.querySelector('#saveProfileButton'),
  newProfileButton: document.querySelector('#newProfileButton'),
  deleteProfileButton: document.querySelector('#deleteProfileButton'),
  storePrefix: document.querySelector('#storePrefix'),
  layerPrefix: document.querySelector('#layerPrefix'),
  overwrite: document.querySelector('#overwrite'),
  dropzone: document.querySelector('#dropzone'),
  pickFilesButton: document.querySelector('#pickFilesButton'),
  pickFolderButton: document.querySelector('#pickFolderButton'),
  clearFilesButton: document.querySelector('#clearFilesButton'),
  fileInput: document.querySelector('#fileInput'),
  folderInput: document.querySelector('#folderInput'),
  uploadSummary: document.querySelector('#uploadSummary'),
  groupList: document.querySelector('#groupList'),
  groupCountBadge: document.querySelector('#groupCountBadge'),
  publishButton: document.querySelector('#publishButton'),
  publishResult: document.querySelector('#publishResult'),
  maxFeatures: document.querySelector('#maxFeatures'),
  queryWfsButton: document.querySelector('#queryWfsButton'),
  wfsResult: document.querySelector('#wfsResult'),
  groupTemplate: document.querySelector('#groupTemplate'),
};

function sanitizeName(value) {
  return String(value ?? '').trim().replace(/\s+/g, '_');
}

function normalizeFilePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
}

function sortedAllowedSuffixes() {
  return [...state.meta.allowedSuffixes].sort((left, right) => right.length - left.length);
}

function splitShapefileName(filePath) {
  const normalized = normalizeFilePath(filePath);
  const parts = normalized.split('/');
  const fileName = parts[parts.length - 1] || '';
  const lowerName = fileName.toLowerCase();

  for (const suffix of sortedAllowedSuffixes()) {
    if (lowerName.endsWith(suffix) && lowerName.length > suffix.length) {
      return {
        suffix,
        baseName: fileName.slice(0, fileName.length - suffix.length),
      };
    }
  }

  return null;
}

function buildGroupKey(dirName, baseName) {
  return `${dirName}::${baseName.toLowerCase()}`;
}

function currentStorePrefix() {
  return elements.storePrefix.value || '';
}

function currentLayerPrefix() {
  return elements.layerPrefix.value || '';
}

function defaultStoreName(baseName) {
  return sanitizeName(`${currentStorePrefix()}${baseName}`);
}

function defaultLayerName(baseName) {
  return sanitizeName(`${currentLayerPrefix()}${baseName}`);
}

function readProfiles() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeProfiles() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.profiles));
}

function updateHeroStats() {
  elements.profileCount.textContent = String(state.profiles.length);
  elements.requiredSuffixes.textContent = state.meta.requiredShapefileSuffixes.join(' / ');
}

function renderProfileSelect() {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.profiles.length > 0 ? '选择已保存配置' : '暂无已保存配置';

  elements.profileSelect.innerHTML = '';
  elements.profileSelect.appendChild(placeholder);

  state.profiles.forEach((profile) => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.profileName;
    if (profile.id === state.selectedProfileId) {
      option.selected = true;
    }
    elements.profileSelect.appendChild(option);
  });
}

function setConnectionForm(profile) {
  elements.profileName.value = profile?.profileName || '';
  elements.geoserverUrl.value = profile?.geoserverUrl || '';
  elements.workspace.value = profile?.workspace || '';
  elements.username.value = profile?.username || '';
  elements.password.value = profile?.password || '';
}

function readConnectionForm() {
  return {
    profileName: elements.profileName.value.trim(),
    geoserverUrl: elements.geoserverUrl.value.trim(),
    workspace: elements.workspace.value.trim(),
    username: elements.username.value.trim(),
    password: elements.password.value,
  };
}

function validateConnectionFields() {
  const connection = readConnectionForm();
  if (!connection.geoserverUrl || !connection.workspace || !connection.username || !connection.password) {
    throw new Error('请先填写完整的 GeoServer Base URL、Workspace、用户名和密码。');
  }
  return connection;
}

function createProfileId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `profile-${Date.now()}`;
}

function saveCurrentProfile() {
  const connection = readConnectionForm();
  if (!connection.profileName) {
    window.alert('保存配置前请先填写配置名称。');
    return;
  }

  const profile = {
    id: state.selectedProfileId || createProfileId(),
    profileName: connection.profileName,
    geoserverUrl: connection.geoserverUrl,
    workspace: connection.workspace,
    username: connection.username,
    password: connection.password,
  };

  const index = state.profiles.findIndex((item) => item.id === profile.id);
  if (index >= 0) {
    state.profiles[index] = profile;
  } else {
    state.profiles.unshift(profile);
  }

  state.selectedProfileId = profile.id;
  localStorage.setItem(SELECTED_PROFILE_KEY, profile.id);
  writeProfiles();
  updateHeroStats();
  renderProfileSelect();
}

function resetConnectionForm() {
  state.selectedProfileId = '';
  localStorage.removeItem(SELECTED_PROFILE_KEY);
  setConnectionForm(null);
  renderProfileSelect();
}

function deleteCurrentProfile() {
  if (!state.selectedProfileId) {
    resetConnectionForm();
    return;
  }

  state.profiles = state.profiles.filter((profile) => profile.id !== state.selectedProfileId);
  writeProfiles();
  resetConnectionForm();
  updateHeroStats();
}

function loadSelectedProfile(profileId) {
  state.selectedProfileId = profileId;
  localStorage.setItem(SELECTED_PROFILE_KEY, profileId);
  const profile = state.profiles.find((item) => item.id === profileId);
  setConnectionForm(profile || null);
  renderProfileSelect();
}

function collectUploadEntries(files) {
  Array.from(files).forEach((file) => {
    const relativePath = normalizeFilePath(file.webkitRelativePath || file.name);
    if (!relativePath) {
      return;
    }
    state.uploadFiles.set(relativePath.toLowerCase(), {
      file,
      relativePath,
    });
  });
}

function regroupUploads() {
  const previousGroups = new Map(state.groups.map((group) => [group.groupKey, group]));
  const grouped = new Map();
  const ignored = [];

  state.uploadFiles.forEach((entry) => {
    const nameInfo = splitShapefileName(entry.relativePath);
    if (!nameInfo) {
      ignored.push(entry.relativePath);
      return;
    }

    const slashIndex = entry.relativePath.lastIndexOf('/');
    const dirName = slashIndex >= 0 ? entry.relativePath.slice(0, slashIndex) : '';
    const groupKey = buildGroupKey(dirName, nameInfo.baseName);
    const previous = previousGroups.get(groupKey);
    const group =
      grouped.get(groupKey) ||
      {
        groupKey,
        dirName,
        baseName: nameInfo.baseName,
        files: [],
        suffixes: new Set(),
        storeName: previous?.storeName || defaultStoreName(nameInfo.baseName),
        layerName: previous?.layerName || defaultLayerName(nameInfo.baseName),
        storeTouched: previous?.storeTouched || false,
        layerTouched: previous?.layerTouched || false,
      };

    group.files.push(entry.relativePath);
    group.suffixes.add(nameInfo.suffix);
    if (!group.storeTouched) {
      group.storeName = defaultStoreName(group.baseName);
    }
    if (!group.layerTouched) {
      group.layerName = defaultLayerName(group.baseName);
    }

    grouped.set(groupKey, group);
  });

  state.ignoredFiles = ignored.sort((left, right) => left.localeCompare(right, 'zh-CN'));
  state.groups = [...grouped.values()]
    .map((group) => ({
      ...group,
      files: [...group.files].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      missing: state.meta.requiredShapefileSuffixes.filter((suffix) => !group.suffixes.has(suffix)),
    }))
    .sort((left, right) => {
      const leftLabel = left.dirName ? `${left.dirName}/${left.baseName}` : left.baseName;
      const rightLabel = right.dirName ? `${right.dirName}/${right.baseName}` : right.baseName;
      return leftLabel.localeCompare(rightLabel, 'zh-CN');
    });

  renderUploadSummary();
  renderGroupList();
  syncBusyState();
}

function renderUploadSummary() {
  const fileCount = state.uploadFiles.size;
  const fullGroups = state.groups.filter((group) => group.missing.length === 0).length;
  const incompleteGroups = state.groups.length - fullGroups;
  const parts = [];

  if (fileCount === 0) {
    parts.push('尚未选择文件');
  } else {
    parts.push(`已载入 ${fileCount} 个文件`);
    parts.push(`识别到 ${state.groups.length} 组图层`);
    parts.push(`完整 ${fullGroups} 组`);
    if (incompleteGroups > 0) {
      parts.push(`待补齐 ${incompleteGroups} 组`);
    }
    if (state.ignoredFiles.length > 0) {
      parts.push(`忽略 ${state.ignoredFiles.length} 个不支持的文件`);
    }
  }

  elements.uploadSummary.innerHTML = '';
  parts.forEach((part) => {
    const chip = document.createElement('span');
    chip.textContent = part;
    elements.uploadSummary.appendChild(chip);
  });

  elements.groupCountBadge.textContent = `${state.groups.length} 组`;
}

function renderGroupList() {
  elements.groupList.innerHTML = '';

  if (state.groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '上传后会在这里看到按图层分好的文件组，以及对应的 store 和 layer 配置。';
    elements.groupList.appendChild(empty);
    return;
  }

  state.groups.forEach((group) => {
    const fragment = elements.groupTemplate.content.cloneNode(true);
    const card = fragment.querySelector('.group-card');
    const title = fragment.querySelector('.group-title');
    const meta = fragment.querySelector('.group-meta');
    const status = fragment.querySelector('.status-chip');
    const fileChipList = fragment.querySelector('.file-chip-list');
    const storeInput = fragment.querySelector('[data-field="storeName"]');
    const layerInput = fragment.querySelector('[data-field="layerName"]');

    title.textContent = group.dirName ? `${group.dirName}/${group.baseName}` : group.baseName;
    if (group.missing.length === 0) {
      meta.textContent = `${group.files.length} 个文件已就绪，将按 UTF-8 发布。`;
      status.textContent = '可发布';
    } else {
      meta.textContent = `缺少 ${group.missing.join(', ')}，当前分组不能发布。`;
      status.textContent = '待补齐';
      status.classList.add('is-error');
      card.classList.add('is-error');
    }

    group.files.forEach((fileName) => {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      chip.textContent = fileName;
      fileChipList.appendChild(chip);
    });

    storeInput.value = group.storeName;
    layerInput.value = group.layerName;

    storeInput.addEventListener('input', (event) => {
      group.storeName = event.target.value;
      group.storeTouched = true;
    });

    layerInput.addEventListener('input', (event) => {
      group.layerName = event.target.value;
      group.layerTouched = true;
    });

    elements.groupList.appendChild(fragment);
  });
}

function updateUntouchedGroupNames() {
  state.groups.forEach((group) => {
    if (!group.storeTouched) {
      group.storeName = defaultStoreName(group.baseName);
    }
    if (!group.layerTouched) {
      group.layerName = defaultLayerName(group.baseName);
    }
  });
  renderGroupList();
}

function syncBusyState() {
  const hasCompleteGroups = state.groups.some((group) => group.missing.length === 0);
  elements.publishButton.disabled = state.isPublishing || !hasCompleteGroups;
  elements.queryWfsButton.disabled = state.isQuerying;
}

function createResultHeader(titleText, summaryText, success) {
  const wrapper = document.createElement('div');
  wrapper.className = 'result-header';

  const left = document.createElement('div');
  const title = document.createElement('h3');
  title.className = 'result-title';
  title.textContent = titleText;
  const copy = document.createElement('p');
  copy.className = 'result-copy';
  copy.textContent = summaryText;
  left.append(title, copy);

  const chip = document.createElement('span');
  chip.className = 'panel-badge';
  chip.textContent = success ? '执行完成' : '需要处理';

  wrapper.append(left, chip);
  return wrapper;
}

function renderPublishResult(payload) {
  elements.publishResult.hidden = false;
  elements.publishResult.innerHTML = '';

  if (!payload.success && !payload.summary) {
    elements.publishResult.append(
      createResultHeader('发布失败', payload.error || '发生未知错误。', false),
    );

    if (Array.isArray(payload.incompleteGroups) && payload.incompleteGroups.length > 0) {
      const list = document.createElement('div');
      list.className = 'result-list';
      payload.incompleteGroups.forEach((group) => {
        const item = document.createElement('div');
        item.className = 'result-item is-error';
        item.innerHTML = `<strong>${group.label}</strong><div>缺少：${group.missing.join(', ')}</div>`;
        list.appendChild(item);
      });
      elements.publishResult.appendChild(list);
    }

    return;
  }

  const summaryText = `成功 ${payload.summary.successCount} 组，失败 ${payload.summary.failureCount} 组。`;
  elements.publishResult.append(
    createResultHeader(payload.success ? '发布完成' : '发布结束，但存在失败项', summaryText, payload.success),
  );

  const resultList = document.createElement('div');
  resultList.className = 'result-list';
  payload.summary.results.forEach((result) => {
    const item = document.createElement('div');
    item.className = `result-item${result.success ? '' : ' is-error'}`;
    const title = document.createElement('strong');
    title.textContent = result.sourcePath;
    const body = document.createElement('div');
    if (result.success) {
      const actionMap = {
        created: '已新建并发布',
        updated: '已覆盖并重新计算范围',
        'skipped-existing': '图层已存在，未启用覆盖，跳过发布',
      };
      const readySuffix =
        result.readiness === 'pending'
          ? '；GeoServer 还在完成查询初始化，WFS/KML 可能需要几秒后更稳定。'
          : '';
      body.textContent = `${result.storeName} / ${result.layerName} - ${actionMap[result.action] || '处理成功'}${readySuffix}`;
    } else {
      body.textContent = result.error || '处理失败';
    }
    item.append(title, body);
    resultList.appendChild(item);
  });
  elements.publishResult.appendChild(resultList);

  if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
    const warningList = document.createElement('div');
    warningList.className = 'result-list';
    payload.warnings.forEach((warning) => {
      const item = document.createElement('div');
      item.className = 'result-item is-warn';
      item.textContent = warning;
      warningList.appendChild(item);
    });
    elements.publishResult.appendChild(warningList);
  }

  if (Array.isArray(payload.logs) && payload.logs.length > 0) {
    const logTitle = document.createElement('p');
    logTitle.className = 'result-copy';
    logTitle.textContent = '服务端处理日志';
    elements.publishResult.appendChild(logTitle);

    const logList = document.createElement('div');
    logList.className = 'log-list';
    payload.logs.forEach((log) => {
      const item = document.createElement('div');
      item.className = `log-item${log.level === 'error' ? ' is-error' : log.level === 'warn' ? ' is-warn' : ''}`;
      item.innerHTML = `<strong>${log.level.toUpperCase()}</strong><div>${log.message}</div>`;
      logList.appendChild(item);
    });
    elements.publishResult.appendChild(logList);
  }
}

function renderWfsResult(payload) {
  elements.wfsResult.hidden = false;
  elements.wfsResult.innerHTML = '';

  elements.wfsResult.append(
    createResultHeader(
      'WFS URL 查询结果',
      payload.count > 0 ? `共找到 ${payload.count} 个已发布图层。` : '当前 Workspace 没有已发布图层。',
      true,
    ),
  );

  if (!payload.data || payload.data.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'GeoServer 返回的 feature types 为空。';
    elements.wfsResult.appendChild(empty);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'wfs-table-wrap';

  const table = document.createElement('table');
  table.className = 'wfs-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Layer</th>
        <th>Title</th>
        <th>WFS URL</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector('tbody');
  payload.data.forEach((entry) => {
    const tr = document.createElement('tr');
    const copyButton = document.createElement('button');
    copyButton.className = 'button';
    copyButton.type = 'button';
    copyButton.textContent = '复制 URL';
    copyButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(entry.wfsUrl);
      copyButton.textContent = '已复制';
      window.setTimeout(() => {
        copyButton.textContent = '复制 URL';
      }, 1200);
    });
    const kmlButton = document.createElement('button');
    kmlButton.className = 'button';
    kmlButton.type = 'button';
    kmlButton.textContent = '下载 KML';
    kmlButton.addEventListener('click', async () => {
      try {
        await downloadLayerKml(entry, kmlButton);
      } catch (error) {
        renderWfsError(error.message);
      }
    });

    const layerCell = document.createElement('td');
    layerCell.textContent = entry.layer;
    const titleCell = document.createElement('td');
    titleCell.textContent = entry.title || '-';
    const urlCell = document.createElement('td');
    urlCell.className = 'wfs-url';
    urlCell.textContent = entry.wfsUrl;
    const actionCell = document.createElement('td');
    actionCell.className = 'wfs-actions-cell';
    const actionInner = document.createElement('div');
    actionInner.className = 'wfs-actions';
    actionInner.appendChild(copyButton);
    actionInner.appendChild(kmlButton);
    actionCell.appendChild(actionInner);

    tr.append(layerCell, titleCell, urlCell, actionCell);
    tbody.appendChild(tr);
  });

  wrap.appendChild(table);
  elements.wfsResult.appendChild(wrap);
}

function renderWfsError(message) {
  elements.wfsResult.hidden = false;
  elements.wfsResult.innerHTML = '';
  elements.wfsResult.append(createResultHeader('WFS URL 查询失败', message, false));
}

async function downloadLayerKml(entry, triggerButton) {
  const connection = validateConnectionFields();
  const layerName = entry.layerName || String(entry.layer || '').split(':').slice(1).join(':');
  const maxFeatures = Number.parseInt(elements.maxFeatures.value || '5000', 10);

  if (!layerName) {
    throw new Error('当前记录缺少图层名称，无法下载 KML。');
  }
  if (!Number.isInteger(maxFeatures) || maxFeatures <= 0) {
    throw new Error('maxFeatures 必须是正整数。');
  }

  const previousText = triggerButton.textContent;
  triggerButton.disabled = true;
  triggerButton.textContent = '下载中...';

  try {
    const response = await fetch('/api/download-kml', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connection: {
          geoserverUrl: connection.geoserverUrl,
          workspace: connection.workspace,
          username: connection.username,
          password: connection.password,
        },
        layerName,
        maxFeatures,
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      throw new Error(errorPayload?.error || 'KML 下载失败。');
    }

    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = downloadUrl;
    downloadLink.download = `${sanitizeName(layerName) || 'layer'}.kml`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    URL.revokeObjectURL(downloadUrl);
  } finally {
    triggerButton.disabled = false;
    triggerButton.textContent = previousText;
  }
}

async function publishCurrentGroups() {
  try {
    const connection = validateConnectionFields();
    const completeGroups = state.groups.filter((group) => group.missing.length === 0);
    if (completeGroups.length === 0) {
      throw new Error('当前没有可发布的完整图层组。');
    }

    const formData = new FormData();
    formData.set(
      'connection',
      JSON.stringify({
        geoserverUrl: connection.geoserverUrl,
        workspace: connection.workspace,
        username: connection.username,
        password: connection.password,
      }),
    );
    formData.set(
      'options',
      JSON.stringify({
        storePrefix: currentStorePrefix(),
        layerPrefix: currentLayerPrefix(),
        overwrite: elements.overwrite.checked,
      }),
    );
    formData.set(
      'groups',
      JSON.stringify(
        completeGroups.map((group) => ({
          groupKey: group.groupKey,
          storeName: group.storeName,
          layerName: group.layerName,
        })),
      ),
    );

    state.uploadFiles.forEach((entry) => {
      formData.append('shapefiles', entry.file, entry.relativePath);
    });

    state.isPublishing = true;
    syncBusyState();
    elements.publishButton.textContent = '发布中...';

    const response = await fetch('/api/publish', {
      method: 'POST',
      body: formData,
    });
    const result = await response.json();

    if (!response.ok) {
      renderPublishResult(result);
      return;
    }

    renderPublishResult(result);
  } catch (error) {
    renderPublishResult({
      success: false,
      error: error.message,
    });
  } finally {
    state.isPublishing = false;
    elements.publishButton.textContent = '开始发布';
    syncBusyState();
  }
}

async function queryWfsUrls() {
  try {
    const connection = validateConnectionFields();
    const maxFeatures = Number.parseInt(elements.maxFeatures.value || '5000', 10);
    if (!Number.isInteger(maxFeatures) || maxFeatures <= 0) {
      throw new Error('maxFeatures 必须是正整数。');
    }

    state.isQuerying = true;
    syncBusyState();
    elements.queryWfsButton.textContent = '查询中...';

    const response = await fetch('/api/wfs-urls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connection: {
          geoserverUrl: connection.geoserverUrl,
          workspace: connection.workspace,
          username: connection.username,
          password: connection.password,
        },
        maxFeatures,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || '查询失败。');
    }

    renderWfsResult(result);
  } catch (error) {
    renderWfsError(error.message);
  } finally {
    state.isQuerying = false;
    elements.queryWfsButton.textContent = '查询 WFS URL';
    syncBusyState();
  }
}

function bindEvents() {
  elements.profileSelect.addEventListener('change', (event) => {
    const profileId = event.target.value;
    if (!profileId) {
      resetConnectionForm();
      return;
    }
    loadSelectedProfile(profileId);
  });

  elements.saveProfileButton.addEventListener('click', saveCurrentProfile);
  elements.newProfileButton.addEventListener('click', resetConnectionForm);
  elements.deleteProfileButton.addEventListener('click', deleteCurrentProfile);
  elements.pickFilesButton.addEventListener('click', () => elements.fileInput.click());
  elements.pickFolderButton.addEventListener('click', () => elements.folderInput.click());
  elements.clearFilesButton.addEventListener('click', () => {
    state.uploadFiles.clear();
    regroupUploads();
  });
  elements.publishButton.addEventListener('click', publishCurrentGroups);
  elements.queryWfsButton.addEventListener('click', queryWfsUrls);

  elements.fileInput.addEventListener('change', (event) => {
    collectUploadEntries(event.target.files);
    event.target.value = '';
    regroupUploads();
  });

  elements.folderInput.addEventListener('change', (event) => {
    collectUploadEntries(event.target.files);
    event.target.value = '';
    regroupUploads();
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'dragend', 'drop'].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.remove('is-dragover');
    });
  });

  elements.dropzone.addEventListener('drop', (event) => {
    collectUploadEntries(event.dataTransfer?.files || []);
    regroupUploads();
  });

  elements.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      elements.fileInput.click();
    }
  });

  elements.storePrefix.addEventListener('input', updateUntouchedGroupNames);
  elements.layerPrefix.addEventListener('input', updateUntouchedGroupNames);
}

async function loadMeta() {
  try {
    const response = await fetch('/api/meta');
    const payload = await response.json();
    if (response.ok && payload?.data) {
      state.meta = payload.data;
    }
  } catch {
    state.meta = fallbackMeta;
  }
}

async function init() {
  await loadMeta();
  state.profiles = readProfiles();
  state.selectedProfileId = localStorage.getItem(SELECTED_PROFILE_KEY) || '';

  updateHeroStats();
  renderProfileSelect();
  if (state.selectedProfileId) {
    const selected = state.profiles.find((profile) => profile.id === state.selectedProfileId);
    if (selected) {
      setConnectionForm(selected);
    }
  }

  renderUploadSummary();
  renderGroupList();
  syncBusyState();
  bindEvents();
}

init();
