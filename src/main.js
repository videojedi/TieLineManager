const { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const VirtualRouter = require('./virtual-router');
const TieLineEngine = require('./tie-line-engine');

// Optional controllers (may not be available in all builds)
let VideoHubController, SWP08Controller, GVNativeController;
try { VideoHubController = require('./videohub-controller'); } catch (e) {}
try { SWP08Controller = require('./swp08-controller'); } catch (e) {}
try { GVNativeController = require('./gvnative-controller'); } catch (e) {}

let mainWindow;
let controllerA = null;
let controllerB = null;
let tieLineEngine = null;
let virtualRouter = null;
let settings = {};

// Settings persistence
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'tie-line-manager-settings.json');
}

function loadSettings() {
  try {
    const data = fs.readFileSync(getSettingsPath(), 'utf-8');
    settings = JSON.parse(data);
  } catch (e) {
    settings = {
      routerA: { host: '127.0.0.1', port: 9990, protocol: 'videohub', levels: 1, name: 'Router A' },
      routerB: { host: '127.0.0.1', port: 9991, protocol: 'videohub', levels: 1, name: 'Router B' },
      tieLines: { aToB: [], bToA: [] },
      salvos: [],
      autoConnect: false,
      autoReconnect: true,
      activeLevel: 0,
      activeTab: 'setup'
    };
  }
  // Ensure defaults
  if (!settings.tieLines) settings.tieLines = { aToB: [], bToA: [] };
  if (!settings.salvos) settings.salvos = [];
  if (!settings.routerA) settings.routerA = { host: '127.0.0.1', port: 9990, protocol: 'videohub', levels: 1, name: 'Router A' };
  if (!settings.routerB) settings.routerB = { host: '127.0.0.1', port: 9991, protocol: 'videohub', levels: 1, name: 'Router B' };
}

function saveSettings() {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// Controller factory
function createController(protocol, config) {
  if (protocol === 'swp08' && SWP08Controller) {
    return new SWP08Controller(config);
  } else if (protocol === 'gvnative' && GVNativeController) {
    return new GVNativeController(config);
  } else if (VideoHubController) {
    return new VideoHubController(config);
  }
  return null;
}

// Attach events from a controller, prefixed with router ID
function attachControllerEvents(controller, routerId) {
  controller.on('connected', () => {
    sendToRenderer(`router-${routerId}-connected`, controller.getState());
    rebuildVirtualState();
  });

  controller.on('disconnected', () => {
    sendToRenderer(`router-${routerId}-disconnected`);
    rebuildVirtualState();
  });

  controller.on('reconnecting', (attempt) => {
    sendToRenderer(`router-${routerId}-reconnecting`, attempt);
  });

  controller.on('routing-changed', (changes) => {
    sendToRenderer(`router-${routerId}-routing-changed`, changes);
    rebuildVirtualState();
  });

  controller.on('input-labels-changed', (changes) => {
    sendToRenderer(`router-${routerId}-input-labels-changed`, changes);
    rebuildVirtualState();
  });

  controller.on('output-labels-changed', (changes) => {
    sendToRenderer(`router-${routerId}-output-labels-changed`, changes);
    rebuildVirtualState();
  });

  controller.on('locks-changed', (changes) => {
    sendToRenderer(`router-${routerId}-locks-changed`, changes);
    rebuildVirtualState();
  });

  controller.on('state-updated', () => {
    rebuildVirtualState();
  });

  controller.on('error', (err) => {
    sendToRenderer(`router-${routerId}-error`, err.message || err);
  });
}

function rebuildVirtualState() {
  const stateA = controllerA?.isConnected() ? controllerA.getState() : null;
  const stateB = controllerB?.isConnected() ? controllerB.getState() : null;

  if (!virtualRouter) {
    virtualRouter = new VirtualRouter(stateA, stateB, settings.tieLines, tieLineEngine?.getState());
  } else {
    virtualRouter.update(stateA, stateB, settings.tieLines, tieLineEngine?.getState());
  }

  // Reconstruct tie-line state if both connected
  if (tieLineEngine && controllerA?.isConnected() && controllerB?.isConnected()) {
    tieLineEngine.reconstructStateFromRouting();
    virtualRouter.update(null, null, null, tieLineEngine.getState());
  }

  sendToRenderer('virtual-state-updated', virtualRouter.getState());
  sendToRenderer('tie-line-state-updated', tieLineEngine?.getState() || { aToB: [], bToA: [] });
}

function ensureEngine() {
  if (!tieLineEngine) {
    tieLineEngine = new TieLineEngine(controllerA, controllerB, settings.tieLines);
    tieLineEngine.on('state-changed', () => {
      sendToRenderer('tie-line-state-updated', tieLineEngine.getState());
    });
  }
}

// Window creation
function createWindow() {
  mainWindow = new BrowserWindow({
    width: settings.windowWidth || 1400,
    height: settings.windowHeight || 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    settings.windowWidth = w;
    settings.windowHeight = h;
    saveSettings();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Register IPC handlers
function setupIPC() {
  // Connection management
  ipcMain.handle('connect-router', async (event, routerId, config) => {
    try {
      const routerConfig = routerId === 'A' ? settings.routerA : settings.routerB;
      Object.assign(routerConfig, config);
      saveSettings();

      let controller = routerId === 'A' ? controllerA : controllerB;

      // Clean up existing
      if (controller) {
        controller.removeAllListeners();
        await controller.disconnect().catch(() => {});
      }

      controller = createController(config.protocol, {
        host: config.host,
        port: config.port,
        levels: config.levels || 1,
        autoReconnect: settings.autoReconnect !== false,
        timeout: 5000
      });

      if (!controller) {
        return { success: false, error: 'Controller not available for this protocol' };
      }

      if (routerId === 'A') {
        controllerA = controller;
      } else {
        controllerB = controller;
      }

      attachControllerEvents(controller, routerId);
      ensureEngine();
      tieLineEngine.controllerA = controllerA;
      tieLineEngine.controllerB = controllerB;

      await controller.connect();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('disconnect-router', async (event, routerId) => {
    try {
      const controller = routerId === 'A' ? controllerA : controllerB;
      if (controller) {
        controller.removeAllListeners();
        await controller.disconnect().catch(() => {});
        if (routerId === 'A') controllerA = null;
        else controllerB = null;
      }
      rebuildVirtualState();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-connection-status', (event, routerId) => {
    const controller = routerId === 'A' ? controllerA : controllerB;
    return { connected: controller?.isConnected() || false };
  });

  // State
  ipcMain.handle('get-virtual-state', () => {
    if (!virtualRouter) {
      rebuildVirtualState();
    }
    return virtualRouter?.getState() || { inputs: 0, outputs: 0, routing: {}, inputLabels: {}, outputLabels: {} };
  });

  ipcMain.handle('get-router-state', (event, routerId) => {
    const controller = routerId === 'A' ? controllerA : controllerB;
    return controller?.isConnected() ? controller.getState() : null;
  });

  ipcMain.handle('get-tie-line-state', () => {
    return tieLineEngine?.getState() || { aToB: [], bToA: [] };
  });

  ipcMain.handle('release-all-tie-lines', () => {
    if (!tieLineEngine) return { success: false, error: 'Engine not initialized' };
    tieLineEngine.releaseAllTieLines();
    rebuildVirtualState();
    return { success: true };
  });

  // Virtual routing
  ipcMain.handle('set-virtual-route', async (event, virtualOutput, virtualInput, level = 0) => {
    ensureEngine();
    if (!virtualRouter) rebuildVirtualState();
    const result = await tieLineEngine.executeVirtualRoute(virtualOutput, virtualInput, virtualRouter, level);
    if (result.success) {
      // Rebuild after route
      setTimeout(() => rebuildVirtualState(), 100);
    }
    return result;
  });

  // Destination locks
  ipcMain.handle('set-virtual-lock', async (event, virtualOutput, lockState) => {
    if (!virtualRouter) rebuildVirtualState();
    if (!virtualRouter) return { success: false, error: 'Virtual router not ready' };

    const resolved = virtualRouter.resolveOutput(virtualOutput);
    if (!resolved) return { success: false, error: 'Invalid virtual output' };

    const controller = resolved.router === 'A' ? controllerA : controllerB;
    if (!controller?.isConnected()) {
      return { success: false, error: `Router ${resolved.router} is not connected` };
    }

    try {
      await controller.setLock(resolved.physicalIndex, lockState);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Tie-line configuration
  ipcMain.handle('get-tie-line-config', () => {
    return settings.tieLines || { aToB: [], bToA: [] };
  });

  ipcMain.handle('set-tie-line-config', (event, config) => {
    settings.tieLines = config;
    saveSettings();
    ensureEngine();
    tieLineEngine.updateConfig(config);
    rebuildVirtualState();
    return { success: true };
  });

  ipcMain.handle('add-tie-line', (event, direction, mapping) => {
    if (!settings.tieLines[direction]) settings.tieLines[direction] = [];
    settings.tieLines[direction].push(mapping);
    saveSettings();
    ensureEngine();
    tieLineEngine.updateConfig(settings.tieLines);
    rebuildVirtualState();

    // Label the tie-line ports on the routers
    const tlNum = settings.tieLines[direction].length;
    const arrow = direction === 'aToB' ? 'A>B' : 'B>A';
    const tlLabel = `TL${tlNum} ${arrow}`;
    if (direction === 'aToB') {
      if (controllerA?.isConnected()) controllerA.setOutputLabel(mapping.routerAOutput, tlLabel);
      if (controllerB?.isConnected()) controllerB.setInputLabel(mapping.routerBInput, tlLabel);
    } else {
      if (controllerB?.isConnected()) controllerB.setOutputLabel(mapping.routerBOutput, tlLabel);
      if (controllerA?.isConnected()) controllerA.setInputLabel(mapping.routerAInput, tlLabel);
    }

    return { success: true, tieLines: settings.tieLines };
  });

  ipcMain.handle('remove-tie-line', (event, direction, index) => {
    if (settings.tieLines[direction]) {
      settings.tieLines[direction].splice(index, 1);
      saveSettings();
      ensureEngine();
      tieLineEngine.updateConfig(settings.tieLines);
      rebuildVirtualState();
    }
    return { success: true, tieLines: settings.tieLines };
  });

  // Labels — resolve virtual index to physical router
  ipcMain.handle('set-input-label', (event, virtualIndex, label) => {
    if (!virtualRouter) return { success: false, error: 'Not initialized' };
    const resolved = virtualRouter.resolveInput(virtualIndex);
    if (!resolved) return { success: false, error: 'Invalid index' };

    const controller = resolved.router === 'A' ? controllerA : controllerB;
    if (!controller?.isConnected()) return { success: false, error: `Router ${resolved.router} not connected` };

    controller.setInputLabel(resolved.physicalIndex, label);
    return { success: true };
  });

  ipcMain.handle('set-output-label', (event, virtualIndex, label) => {
    if (!virtualRouter) return { success: false, error: 'Not initialized' };
    const resolved = virtualRouter.resolveOutput(virtualIndex);
    if (!resolved) return { success: false, error: 'Invalid index' };

    const controller = resolved.router === 'A' ? controllerA : controllerB;
    if (!controller?.isConnected()) return { success: false, error: `Router ${resolved.router} not connected` };

    controller.setOutputLabel(resolved.physicalIndex, label);
    return { success: true };
  });

  // Settings
  ipcMain.handle('get-settings', () => settings);

  ipcMain.handle('save-settings', (event, newSettings) => {
    Object.assign(settings, newSettings);
    saveSettings();
    return { success: true };
  });

  ipcMain.handle('set-auto-connect', (event, enabled) => {
    settings.autoConnect = enabled;
    saveSettings();
    return { success: true };
  });

  ipcMain.handle('set-auto-reconnect', (event, enabled) => {
    settings.autoReconnect = enabled;
    saveSettings();
    return { success: true };
  });

  // Salvos
  ipcMain.handle('get-salvos', () => {
    return settings.salvos || [];
  });

  ipcMain.handle('save-salvo', (event, salvo) => {
    if (!settings.salvos) settings.salvos = [];
    if (!salvo.id) {
      salvo.id = `salvo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    salvo.createdAt = salvo.createdAt || new Date().toISOString();
    salvo.updatedAt = new Date().toISOString();

    const existingIndex = settings.salvos.findIndex(s => s.id === salvo.id);
    if (existingIndex >= 0) {
      settings.salvos[existingIndex] = salvo;
    } else {
      settings.salvos.push(salvo);
    }
    saveSettings();
    return { success: true, salvo, salvos: settings.salvos };
  });

  ipcMain.handle('delete-salvo', (event, salvoId) => {
    if (!settings.salvos) return { success: false, error: 'No salvos found' };
    const index = settings.salvos.findIndex(s => s.id === salvoId);
    if (index < 0) return { success: false, error: 'Salvo not found' };
    settings.salvos.splice(index, 1);
    saveSettings();
    return { success: true, salvos: settings.salvos };
  });

  ipcMain.handle('capture-salvo', (event, name, selectedOutputs) => {
    if (!virtualRouter) return { success: false, error: 'Not initialized' };

    const vState = virtualRouter.getState();
    const routes = [];

    const outputsToCapture = selectedOutputs && selectedOutputs.length > 0
      ? selectedOutputs
      : Array.from({ length: vState.outputs }, (_, i) => i);

    for (const vOutput of outputsToCapture) {
      const vInput = vState.routing[vOutput];
      if (vInput !== undefined) {
        routes.push({
          output: vOutput,
          input: vInput,
          outputLabel: vState.outputLabels[vOutput] || `Output ${vOutput + 1}`,
          inputLabel: vState.inputLabels[vInput] || `Input ${vInput + 1}`,
          outputRouter: vState.outputRouterMap[vOutput] || 'A',
          inputRouter: vState.inputRouterMap[vInput] || 'A'
        });
      }
    }

    const salvo = {
      id: `salvo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: name || `Salvo ${(settings.salvos?.length || 0) + 1}`,
      routes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (!settings.salvos) settings.salvos = [];
    settings.salvos.push(salvo);
    saveSettings();

    return { success: true, salvo, salvos: settings.salvos };
  });

  ipcMain.handle('recall-salvo', async (event, salvoId) => {
    if (!settings.salvos) return { success: false, error: 'No salvos found' };
    const salvo = settings.salvos.find(s => s.id === salvoId);
    if (!salvo) return { success: false, error: 'Salvo not found' };

    ensureEngine();
    if (!virtualRouter) rebuildVirtualState();

    const errors = [];
    let appliedCount = 0;

    for (const route of salvo.routes) {
      const result = await tieLineEngine.executeVirtualRoute(route.output, route.input, virtualRouter, 0);
      if (result.success) {
        appliedCount++;
      } else {
        errors.push(`${route.outputLabel || `Out ${route.output + 1}`}: ${result.error}`);
      }
    }

    setTimeout(() => rebuildVirtualState(), 100);

    return {
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      appliedCount
    };
  });

  // Salvo CSV export/import
  ipcMain.handle('export-salvos', async () => {
    const salvos = settings.salvos || [];
    if (salvos.length === 0) return { success: false, error: 'No salvos to export' };

    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Salvos',
      defaultPath: 'salvos-export.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return { success: false, error: 'Cancelled' };

    const header = 'salvo_name,output,input,output_label,input_label,output_router,input_router,created_at';
    const rows = [];
    for (const salvo of salvos) {
      for (const route of salvo.routes) {
        rows.push([
          csvEscape(salvo.name),
          route.output, route.input,
          csvEscape(route.outputLabel || ''),
          csvEscape(route.inputLabel || ''),
          csvEscape(route.outputRouter || ''),
          csvEscape(route.inputRouter || ''),
          csvEscape(salvo.createdAt || '')
        ].join(','));
      }
    }
    fs.writeFileSync(filePath, header + '\n' + rows.join('\n') + '\n', 'utf-8');
    return { success: true, count: salvos.length, filePath };
  });

  ipcMain.handle('import-salvos', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Salvos',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      properties: ['openFile']
    });
    if (canceled || !filePaths?.length) return { success: false, error: 'Cancelled' };

    try {
      const csv = fs.readFileSync(filePaths[0], 'utf-8');
      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length < 2) return { success: false, error: 'CSV file is empty' };

      const salvoMap = {};
      for (let i = 1; i < lines.length; i++) {
        const fields = csvParseLine(lines[i]);
        if (fields.length < 5) continue;
        const name = fields[0];
        if (!salvoMap[name]) {
          salvoMap[name] = {
            id: `salvo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${i}`,
            name, routes: [],
            createdAt: fields[7] || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
        }
        salvoMap[name].routes.push({
          output: parseInt(fields[1]) || 0,
          input: parseInt(fields[2]) || 0,
          outputLabel: fields[3] || '',
          inputLabel: fields[4] || '',
          outputRouter: fields[5] || '',
          inputRouter: fields[6] || ''
        });
      }

      const imported = Object.values(salvoMap);
      if (imported.length === 0) return { success: false, error: 'No valid salvos found' };

      const existingNames = new Set((settings.salvos || []).map(s => s.name));
      const duplicateNames = imported.filter(s => existingNames.has(s.name)).map(s => s.name);

      if (duplicateNames.length > 0) {
        return { success: true, needsResolution: true, imported, duplicateNames };
      }

      if (!settings.salvos) settings.salvos = [];
      settings.salvos.push(...imported);
      saveSettings();
      return { success: true, count: imported.length, salvos: settings.salvos };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('import-salvos-resolve', (event, imported, resolution) => {
    if (!settings.salvos) settings.salvos = [];
    const existingByName = {};
    settings.salvos.forEach(s => { existingByName[s.name] = s; });

    let added = 0;
    for (const salvo of imported) {
      const existing = existingByName[salvo.name];
      if (existing) {
        if (resolution === 'overwrite') {
          const idx = settings.salvos.findIndex(s => s.id === existing.id);
          if (idx >= 0) { salvo.id = existing.id; settings.salvos[idx] = salvo; }
          added++;
        } else if (resolution === 'rename') {
          let newName = salvo.name + ' (imported)';
          let counter = 2;
          const allNames = new Set(settings.salvos.map(s => s.name));
          while (allNames.has(newName)) { newName = salvo.name + ` (imported ${counter})`; counter++; }
          salvo.name = newName;
          settings.salvos.push(salvo);
          added++;
        }
      } else {
        settings.salvos.push(salvo);
        added++;
      }
    }
    saveSettings();
    return { success: true, count: added, salvos: settings.salvos };
  });

  // Update checker
  ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
  });
}

function csvEscape(value) {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function csvParseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(current); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current);
  return fields;
}

// App lifecycle
app.whenReady().then(async () => {
  loadSettings();

  // Set up About panel
  const iconsPath = path.join(__dirname, '..', 'icons');
  const logoPath = path.join(iconsPath, 'VWLogo.png');

  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'Tie-Line Manager',
      applicationVersion: require('../package.json').version,
      copyright: 'Video Walrus Ltd.',
      iconPath: logoPath
    });
  }

  // Application menu
  const menuTemplate = [];
  if (process.platform === 'darwin') {
    menuTemplate.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  menuTemplate.push(
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' }
      ]
    }
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // Set up IPC handlers
  setupIPC();

  // Initialize engine
  ensureEngine();
  virtualRouter = new VirtualRouter(null, null, settings.tieLines, tieLineEngine.getState());

  // Create window
  createWindow();
});

app.on('window-all-closed', () => {
  // Disconnect controllers on quit
  if (controllerA) { controllerA.removeAllListeners(); controllerA.disconnect().catch(() => {}); }
  if (controllerB) { controllerB.removeAllListeners(); controllerB.disconnect().catch(() => {}); }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
