const net = require('net');
const EventEmitter = require('events');

class VideoHubBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 9990;
    this.modelName = options.modelName || 'Blackmagic Smart Videohub';
    this.friendlyName = options.friendlyName || 'TieLineManager Virtual Router';
    this.protocolVersion = '2.8';

    // TCP client lock ownership (output index -> socket)
    this.lockOwners = {};

    this.clients = new Set();
    this.server = null;
    this._previousState = null;

    // Dependencies (set via setDependencies)
    this.virtualRouter = null;
    this.tieLineEngine = null;
    this.controllerA = null;
    this.controllerB = null;
  }

  setDependencies({ virtualRouter, tieLineEngine, controllerA, controllerB }) {
    this.virtualRouter = virtualRouter;
    this.tieLineEngine = tieLineEngine;
    this.controllerA = controllerA;
    this.controllerB = controllerB;
  }

  _getVirtualState() {
    if (!this.virtualRouter) return null;
    return this.virtualRouter.getState();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.port, () => {
        this._previousState = this._getVirtualState();
        this.emit('started', this.port);
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.lockOwners = {};

      for (const client of this.clients) {
        client.destroy();
      }
      this.clients.clear();

      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.emit('stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  handleConnection(socket) {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    this.clients.add(socket);
    this.emit('client-connected', clientId);

    // Send initial status dump
    socket.write(this.getFullStatus(socket));

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop();

      for (const block of blocks) {
        if (block.trim()) {
          this.processCommand(socket, block.trim(), clientId);
        }
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);

      // Release TCP client locks and unlock on physical routers
      const changes = [];
      const vs = this._getVirtualState();
      const totalOutputs = vs ? vs.outputs : 0;

      for (let i = 0; i < totalOutputs; i++) {
        if (this.lockOwners[i] === socket) {
          this.lockOwners[i] = null;
          changes.push({ output: i });
          // Unlock on physical router
          const resolved = this.virtualRouter?.resolveOutput(i);
          if (resolved) {
            const controller = resolved.router === 'A' ? this.controllerA : this.controllerB;
            if (controller?.isConnected()) {
              try { controller.setLock(resolved.physicalIndex, 'U'); } catch (e) {}
            }
          }
        }
      }

      if (changes.length > 0) {
        this.broadcastLockChange(changes);
        this.emit('locks-changed', changes.map(c => ({ output: c.output, lock: 'U' })));
      }

      this.emit('client-disconnected', clientId);
    });

    socket.on('error', (err) => {
      this.emit('client-error', { clientId, error: err });
      this.clients.delete(socket);
    });
  }

  async processCommand(socket, block, clientId) {
    const lines = block.split('\n');
    const header = lines[0];

    this.emit('command-received', { clientId, command: block });

    if (header === 'PING:') {
      socket.write('ACK\n\n');
      return;
    }

    if (header === 'VIDEO OUTPUT ROUTING:') {
      const dataLines = lines.slice(1).filter(l => l.trim());
      const vs = this._getVirtualState();
      if (!vs) { socket.write('NAK\n\n'); return; }

      if (dataLines.length === 0) {
        // Query
        socket.write('ACK\n\n');
        let response = 'VIDEO OUTPUT ROUTING:\n';
        for (let i = 0; i < vs.outputs; i++) {
          response += `${i} ${vs.routing[i] !== undefined ? vs.routing[i] : 0}\n`;
        }
        response += '\n';
        socket.write(response);
        return;
      }

      // Command - route through tieLineEngine
      socket.write('ACK\n\n');

      for (const line of dataLines) {
        const parts = line.split(' ');
        if (parts.length === 2) {
          const output = parseInt(parts[0], 10);
          const input = parseInt(parts[1], 10);

          if (output < 0 || output >= vs.outputs || input < 0 || input >= vs.inputs) continue;

          // Check TCP client lock
          if (this.lockOwners[output] && this.lockOwners[output] !== socket) continue;

          // Check physical router lock
          const physLock = vs.outputLocks?.[output] || 'U';
          if (physLock === 'O' || physLock === 'L') continue;

          // Execute through tie-line engine
          const result = await this.tieLineEngine.executeVirtualRoute(
            output, input, this.virtualRouter, 0
          );

          if (!result.success) {
            // Failed route (e.g., no tie-lines) - report current crosspoint
            const currentInput = vs.routing[output];
            this.broadcastRoutingChange([{ output, input: currentInput !== undefined ? currentInput : 0 }]);
          }
          // Successful routes broadcast via rebuildVirtualState -> onVirtualStateChanged
        }
      }
      return;
    }

    if (header === 'VIDEO OUTPUT LOCKS:') {
      const dataLines = lines.slice(1).filter(l => l.trim());
      const vs = this._getVirtualState();
      if (!vs) { socket.write('NAK\n\n'); return; }

      if (dataLines.length === 0) {
        // Query
        socket.write('ACK\n\n');
        let response = 'VIDEO OUTPUT LOCKS:\n';
        for (let i = 0; i < vs.outputs; i++) {
          response += `${i} ${this._getLockStateForClient(socket, i, vs)}\n`;
        }
        response += '\n';
        socket.write(response);
        return;
      }

      // Command
      const changes = [];
      for (const line of dataLines) {
        const parts = line.split(' ');
        if (parts.length >= 2) {
          const output = parseInt(parts[0], 10);
          const lockState = parts[1].toUpperCase();

          if (output < 0 || output >= vs.outputs) continue;

          if (lockState === 'O') {
            this.lockOwners[output] = socket;
            // Forward to physical router
            const resolved = this.virtualRouter.resolveOutput(output);
            if (resolved) {
              const controller = resolved.router === 'A' ? this.controllerA : this.controllerB;
              if (controller?.isConnected()) {
                try { controller.setLock(resolved.physicalIndex, 'O'); } catch (e) {}
              }
            }
            changes.push({ output, socket });
          } else if (lockState === 'U') {
            if (!this.lockOwners[output] || this.lockOwners[output] === socket) {
              this.lockOwners[output] = null;
              const resolved = this.virtualRouter.resolveOutput(output);
              if (resolved) {
                const controller = resolved.router === 'A' ? this.controllerA : this.controllerB;
                if (controller?.isConnected()) {
                  try { controller.setLock(resolved.physicalIndex, 'U'); } catch (e) {}
                }
              }
              changes.push({ output, socket });
            }
          } else if (lockState === 'F') {
            this.lockOwners[output] = null;
            const resolved = this.virtualRouter.resolveOutput(output);
            if (resolved) {
              const controller = resolved.router === 'A' ? this.controllerA : this.controllerB;
              if (controller?.isConnected()) {
                try { controller.setLock(resolved.physicalIndex, 'U'); } catch (e) {}
              }
            }
            changes.push({ output, socket });
          }
        }
      }

      if (changes.length > 0) {
        socket.write('ACK\n\n');
        this.broadcastLockChange(changes);
        this.emit('locks-changed', changes.map(c => ({
          output: c.output,
          lock: this.lockOwners[c.output] ? 'O' : 'U'
        })));
      } else {
        socket.write('NAK\n\n');
      }
      return;
    }

    if (header === 'INPUT LABELS:') {
      const dataLines = lines.slice(1).filter(l => l.trim());
      const vs = this._getVirtualState();
      if (!vs) { socket.write('NAK\n\n'); return; }

      if (dataLines.length === 0) {
        // Query
        socket.write('ACK\n\n');
        let response = 'INPUT LABELS:\n';
        for (let i = 0; i < vs.inputs; i++) {
          response += `${i} ${vs.inputLabels[i] || `Input ${i + 1}`}\n`;
        }
        response += '\n';
        socket.write(response);
        return;
      }

      // Command - resolve virtual index and set on physical router
      const changes = [];
      for (const line of dataLines) {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (match) {
          const virtualIdx = parseInt(match[1], 10);
          const label = match[2];
          if (virtualIdx >= 0 && virtualIdx < vs.inputs) {
            const resolved = this.virtualRouter.resolveInput(virtualIdx);
            if (resolved) {
              const controller = resolved.router === 'A' ? this.controllerA : this.controllerB;
              if (controller?.isConnected()) {
                try {
                  controller.setInputLabel(resolved.physicalIndex, label);
                  changes.push({ input: virtualIdx, label });
                } catch (e) {}
              }
            }
          }
        }
      }

      socket.write(changes.length > 0 ? 'ACK\n\n' : 'NAK\n\n');
      return;
    }

    if (header === 'OUTPUT LABELS:') {
      const dataLines = lines.slice(1).filter(l => l.trim());
      const vs = this._getVirtualState();
      if (!vs) { socket.write('NAK\n\n'); return; }

      if (dataLines.length === 0) {
        // Query
        socket.write('ACK\n\n');
        let response = 'OUTPUT LABELS:\n';
        for (let i = 0; i < vs.outputs; i++) {
          response += `${i} ${vs.outputLabels[i] || `Output ${i + 1}`}\n`;
        }
        response += '\n';
        socket.write(response);
        return;
      }

      // Command - resolve virtual index and set on physical router
      const changes = [];
      for (const line of dataLines) {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (match) {
          const virtualIdx = parseInt(match[1], 10);
          const label = match[2];
          if (virtualIdx >= 0 && virtualIdx < vs.outputs) {
            const resolved = this.virtualRouter.resolveOutput(virtualIdx);
            if (resolved) {
              const controller = resolved.router === 'A' ? this.controllerA : this.controllerB;
              if (controller?.isConnected()) {
                try {
                  controller.setOutputLabel(resolved.physicalIndex, label);
                  changes.push({ output: virtualIdx, label });
                } catch (e) {}
              }
            }
          }
        }
      }

      socket.write(changes.length > 0 ? 'ACK\n\n' : 'NAK\n\n');
      return;
    }
  }

  getFullStatus(socket) {
    const vs = this._getVirtualState();
    if (!vs) return 'PROTOCOL PREAMBLE:\nVersion: 2.8\n\n';

    let status = '';

    status += 'PROTOCOL PREAMBLE:\n';
    status += `Version: ${this.protocolVersion}\n`;
    status += '\n';

    status += 'VIDEOHUB DEVICE:\n';
    status += 'Device present: true\n';
    status += `Model name: ${this.modelName}\n`;
    status += `Friendly name: ${this.friendlyName}\n`;
    status += 'Unique ID: TIELINE-MGR-001\n';
    status += `Video inputs: ${vs.inputs}\n`;
    status += 'Video processing units: 0\n';
    status += `Video outputs: ${vs.outputs}\n`;
    status += 'Video monitoring outputs: 0\n';
    status += 'Serial ports: 0\n';
    status += '\n';

    status += 'INPUT LABELS:\n';
    for (let i = 0; i < vs.inputs; i++) {
      status += `${i} ${vs.inputLabels[i] || `Input ${i + 1}`}\n`;
    }
    status += '\n';

    status += 'OUTPUT LABELS:\n';
    for (let i = 0; i < vs.outputs; i++) {
      status += `${i} ${vs.outputLabels[i] || `Output ${i + 1}`}\n`;
    }
    status += '\n';

    status += 'VIDEO OUTPUT ROUTING:\n';
    for (let i = 0; i < vs.outputs; i++) {
      status += `${i} ${vs.routing[i] !== undefined ? vs.routing[i] : 0}\n`;
    }
    status += '\n';

    status += 'VIDEO OUTPUT LOCKS:\n';
    for (let i = 0; i < vs.outputs; i++) {
      status += `${i} ${this._getLockStateForClient(socket, i, vs)}\n`;
    }
    status += '\n';

    return status;
  }

  _getLockStateForClient(socket, output, vs) {
    const tcpOwner = this.lockOwners[output];
    if (tcpOwner) {
      return tcpOwner === socket ? 'O' : 'L';
    }
    const physLock = vs?.outputLocks?.[output] || 'U';
    return physLock === 'U' ? 'U' : 'L';
  }

  // State sync - called when virtual state changes (from any source)
  onVirtualStateChanged(newState) {
    if (!this._previousState || this.clients.size === 0) {
      this._previousState = newState;
      return;
    }

    const prev = this._previousState;
    this._previousState = newState;

    // Size changed - re-send full status dump
    if (prev.inputs !== newState.inputs || prev.outputs !== newState.outputs) {
      this.lockOwners = {};
      for (const client of this.clients) {
        try { client.write(this.getFullStatus(client)); } catch (e) {}
      }
      return;
    }

    // Diff routing
    const routingChanges = [];
    for (let i = 0; i < newState.outputs; i++) {
      if (prev.routing[i] !== newState.routing[i]) {
        routingChanges.push({ output: i, input: newState.routing[i] !== undefined ? newState.routing[i] : 0 });
      }
    }
    if (routingChanges.length > 0) {
      this.broadcastRoutingChange(routingChanges);
    }

    // Diff input labels
    const inputLabelChanges = [];
    for (let i = 0; i < newState.inputs; i++) {
      if (prev.inputLabels[i] !== newState.inputLabels[i]) {
        inputLabelChanges.push({ input: i, label: newState.inputLabels[i] || `Input ${i + 1}` });
      }
    }
    if (inputLabelChanges.length > 0) {
      this.broadcastInputLabelChange(inputLabelChanges);
    }

    // Diff output labels
    const outputLabelChanges = [];
    for (let i = 0; i < newState.outputs; i++) {
      if (prev.outputLabels[i] !== newState.outputLabels[i]) {
        outputLabelChanges.push({ output: i, label: newState.outputLabels[i] || `Output ${i + 1}` });
      }
    }
    if (outputLabelChanges.length > 0) {
      this.broadcastOutputLabelChange(outputLabelChanges);
    }

    // Diff locks
    const lockChanges = [];
    for (let i = 0; i < newState.outputs; i++) {
      if (prev.outputLocks?.[i] !== newState.outputLocks?.[i]) {
        lockChanges.push({ output: i });
      }
    }
    if (lockChanges.length > 0) {
      this.broadcastLockChange(lockChanges);
    }
  }

  broadcast(message) {
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (err) {}
    }
  }

  broadcastRoutingChange(changes) {
    let message = 'VIDEO OUTPUT ROUTING:\n';
    for (const change of changes) {
      message += `${change.output} ${change.input}\n`;
    }
    message += '\n';
    this.broadcast(message);
  }

  broadcastLockChange(changes) {
    const vs = this._getVirtualState();
    for (const client of this.clients) {
      let message = 'VIDEO OUTPUT LOCKS:\n';
      for (const change of changes) {
        message += `${change.output} ${this._getLockStateForClient(client, change.output, vs)}\n`;
      }
      message += '\n';
      try { client.write(message); } catch (err) {}
    }
  }

  broadcastInputLabelChange(changes) {
    let message = 'INPUT LABELS:\n';
    for (const change of changes) {
      message += `${change.input} ${change.label}\n`;
    }
    message += '\n';
    this.broadcast(message);
  }

  broadcastOutputLabelChange(changes) {
    let message = 'OUTPUT LABELS:\n';
    for (const change of changes) {
      message += `${change.output} ${change.label}\n`;
    }
    message += '\n';
    this.broadcast(message);
  }

  getStatus() {
    return {
      running: !!(this.server?.listening),
      port: this.port,
      clientCount: this.clients.size,
      clients: Array.from(this.clients).map(s => {
        try { return `${s.remoteAddress}:${s.remotePort}`; } catch (e) { return 'unknown'; }
      })
    };
  }
}

module.exports = VideoHubBridge;
