const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tieLineManager', {
  // Connection management
  connectRouter: (routerId, config) => ipcRenderer.invoke('connect-router', routerId, config),
  disconnectRouter: (routerId) => ipcRenderer.invoke('disconnect-router', routerId),
  getConnectionStatus: (routerId) => ipcRenderer.invoke('get-connection-status', routerId),

  // Virtual state
  getVirtualState: () => ipcRenderer.invoke('get-virtual-state'),
  getRouterState: (routerId) => ipcRenderer.invoke('get-router-state', routerId),
  setVirtualRoute: (output, input, level) => ipcRenderer.invoke('set-virtual-route', output, input, level),

  // Tie-line configuration
  getTieLineConfig: () => ipcRenderer.invoke('get-tie-line-config'),
  setTieLineConfig: (config) => ipcRenderer.invoke('set-tie-line-config', config),
  addTieLine: (direction, mapping) => ipcRenderer.invoke('add-tie-line', direction, mapping),
  removeTieLine: (direction, index) => ipcRenderer.invoke('remove-tie-line', direction, index),
  getTieLineState: () => ipcRenderer.invoke('get-tie-line-state'),

  // Locks
  setVirtualLock: (virtualOutput, lockState) => ipcRenderer.invoke('set-virtual-lock', virtualOutput, lockState),

  // Labels
  setInputLabel: (virtualIndex, label) => ipcRenderer.invoke('set-input-label', virtualIndex, label),
  setOutputLabel: (virtualIndex, label) => ipcRenderer.invoke('set-output-label', virtualIndex, label),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  setAutoConnect: (enabled) => ipcRenderer.invoke('set-auto-connect', enabled),
  setAutoReconnect: (enabled) => ipcRenderer.invoke('set-auto-reconnect', enabled),
  setAutoProtect: (enabled) => ipcRenderer.invoke('set-auto-protect', enabled),

  // Remote Access (VideoHub Bridge)
  startBridge: () => ipcRenderer.invoke('start-bridge'),
  stopBridge: () => ipcRenderer.invoke('stop-bridge'),
  getBridgeStatus: () => ipcRenderer.invoke('get-bridge-status'),
  setRemoteAccessSettings: (settings) => ipcRenderer.invoke('set-remote-access-settings', settings),

  // Salvos
  getSalvos: () => ipcRenderer.invoke('get-salvos'),
  saveSalvo: (salvo) => ipcRenderer.invoke('save-salvo', salvo),
  deleteSalvo: (salvoId) => ipcRenderer.invoke('delete-salvo', salvoId),
  reorderSalvos: (orderedIds) => ipcRenderer.invoke('reorder-salvos', orderedIds),
  setSalvoColor: (salvoId, color) => ipcRenderer.invoke('set-salvo-color', salvoId, color),
  recallSalvo: (salvoId) => ipcRenderer.invoke('recall-salvo', salvoId),
  captureSalvo: (name, selectedOutputs) => ipcRenderer.invoke('capture-salvo', name, selectedOutputs),
  exportSalvos: () => ipcRenderer.invoke('export-salvos'),
  importSalvos: () => ipcRenderer.invoke('import-salvos'),
  importSalvosResolve: (imported, resolution) => ipcRenderer.invoke('import-salvos-resolve', imported, resolution),

  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Update checker
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // External
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Router A event listeners
  onRouterAConnected: (cb) => ipcRenderer.on('router-A-connected', (_, state) => cb(state)),
  onRouterADisconnected: (cb) => ipcRenderer.on('router-A-disconnected', () => cb()),
  onRouterAReconnecting: (cb) => ipcRenderer.on('router-A-reconnecting', (_, attempt) => cb(attempt)),
  onRouterAError: (cb) => ipcRenderer.on('router-A-error', (_, err) => cb(err)),
  onRouterARoutingChanged: (cb) => ipcRenderer.on('router-A-routing-changed', (_, changes) => cb(changes)),
  onRouterAInputLabelsChanged: (cb) => ipcRenderer.on('router-A-input-labels-changed', (_, changes) => cb(changes)),
  onRouterAOutputLabelsChanged: (cb) => ipcRenderer.on('router-A-output-labels-changed', (_, changes) => cb(changes)),

  // Router B event listeners
  onRouterBConnected: (cb) => ipcRenderer.on('router-B-connected', (_, state) => cb(state)),
  onRouterBDisconnected: (cb) => ipcRenderer.on('router-B-disconnected', () => cb()),
  onRouterBReconnecting: (cb) => ipcRenderer.on('router-B-reconnecting', (_, attempt) => cb(attempt)),
  onRouterBError: (cb) => ipcRenderer.on('router-B-error', (_, err) => cb(err)),
  onRouterBRoutingChanged: (cb) => ipcRenderer.on('router-B-routing-changed', (_, changes) => cb(changes)),
  onRouterBInputLabelsChanged: (cb) => ipcRenderer.on('router-B-input-labels-changed', (_, changes) => cb(changes)),
  onRouterBOutputLabelsChanged: (cb) => ipcRenderer.on('router-B-output-labels-changed', (_, changes) => cb(changes)),

  // Virtual state events
  onVirtualStateUpdated: (cb) => ipcRenderer.on('virtual-state-updated', (_, state) => cb(state)),
  onTieLineStateUpdated: (cb) => ipcRenderer.on('tie-line-state-updated', (_, state) => cb(state)),

  // Bridge events
  onBridgeStatusUpdated: (cb) => ipcRenderer.on('bridge-status-updated', (_, status) => cb(status)),
  onBridgeClientConnected: (cb) => ipcRenderer.on('bridge-client-connected', (_, clientId) => cb(clientId)),
  onBridgeClientDisconnected: (cb) => ipcRenderer.on('bridge-client-disconnected', (_, clientId) => cb(clientId)),
  onBridgeError: (cb) => ipcRenderer.on('bridge-error', (_, err) => cb(err)),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
