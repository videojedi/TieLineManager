class VirtualRouter {
  constructor(routerAState, routerBState, tieLineConfig, tieLineState) {
    this.routerA = routerAState || { inputs: 0, outputs: 0, routing: {}, inputLabels: {}, outputLabels: {} };
    this.routerB = routerBState || { inputs: 0, outputs: 0, routing: {}, inputLabels: {}, outputLabels: {} };
    this.tieLineConfig = tieLineConfig || { aToB: [], bToA: [] };
    this.tieLineState = tieLineState || { aToB: [], bToA: [] };

    this._buildExclusionSets();
  }

  _buildExclusionSets() {
    // Tie-line ports should be hidden from the virtual view
    this.excludedAOutputs = new Set(this.tieLineConfig.aToB.map(tl => tl.routerAOutput));
    this.excludedBOutputs = new Set(this.tieLineConfig.bToA.map(tl => tl.routerBOutput));
    this.excludedAInputs = new Set(this.tieLineConfig.bToA.map(tl => tl.routerAInput));
    this.excludedBInputs = new Set(this.tieLineConfig.aToB.map(tl => tl.routerBInput));
  }

  update(routerAState, routerBState, tieLineConfig, tieLineState) {
    if (routerAState) this.routerA = routerAState;
    if (routerBState) this.routerB = routerBState;
    if (tieLineConfig) {
      this.tieLineConfig = tieLineConfig;
      this._buildExclusionSets();
    }
    if (tieLineState) this.tieLineState = tieLineState;
  }

  // Build ordered list of visible input indices for each router
  _getVisibleAInputs() {
    const result = [];
    for (let i = 0; i < this.routerA.inputs; i++) {
      if (!this.excludedAInputs.has(i)) result.push(i);
    }
    return result;
  }

  _getVisibleBInputs() {
    const result = [];
    for (let i = 0; i < this.routerB.inputs; i++) {
      if (!this.excludedBInputs.has(i)) result.push(i);
    }
    return result;
  }

  _getVisibleAOutputs() {
    const result = [];
    for (let i = 0; i < this.routerA.outputs; i++) {
      if (!this.excludedAOutputs.has(i)) result.push(i);
    }
    return result;
  }

  _getVisibleBOutputs() {
    const result = [];
    for (let i = 0; i < this.routerB.outputs; i++) {
      if (!this.excludedBOutputs.has(i)) result.push(i);
    }
    return result;
  }

  get visibleAInputs() { return this._getVisibleAInputs(); }
  get visibleBInputs() { return this._getVisibleBInputs(); }
  get visibleAOutputs() { return this._getVisibleAOutputs(); }
  get visibleBOutputs() { return this._getVisibleBOutputs(); }

  get totalInputs() {
    return this.visibleAInputs.length + this.visibleBInputs.length;
  }

  get totalOutputs() {
    return this.visibleAOutputs.length + this.visibleBOutputs.length;
  }

  // Map virtual input index to { router: 'A'|'B', physicalIndex }
  resolveInput(virtualIndex) {
    const aInputs = this.visibleAInputs;
    if (virtualIndex < aInputs.length) {
      return { router: 'A', physicalIndex: aInputs[virtualIndex] };
    }
    const bIdx = virtualIndex - aInputs.length;
    const bInputs = this.visibleBInputs;
    if (bIdx < bInputs.length) {
      return { router: 'B', physicalIndex: bInputs[bIdx] };
    }
    return null;
  }

  // Map virtual output index to { router: 'A'|'B', physicalIndex }
  resolveOutput(virtualIndex) {
    const aOutputs = this.visibleAOutputs;
    if (virtualIndex < aOutputs.length) {
      return { router: 'A', physicalIndex: aOutputs[virtualIndex] };
    }
    const bIdx = virtualIndex - aOutputs.length;
    const bOutputs = this.visibleBOutputs;
    if (bIdx < bOutputs.length) {
      return { router: 'B', physicalIndex: bOutputs[bIdx] };
    }
    return null;
  }

  // Reverse: physical index to virtual index
  physicalInputToVirtual(router, physicalIndex) {
    if (router === 'A') {
      const aInputs = this.visibleAInputs;
      const idx = aInputs.indexOf(physicalIndex);
      return idx >= 0 ? idx : -1;
    } else {
      const bInputs = this.visibleBInputs;
      const idx = bInputs.indexOf(physicalIndex);
      return idx >= 0 ? this.visibleAInputs.length + idx : -1;
    }
  }

  physicalOutputToVirtual(router, physicalIndex) {
    if (router === 'A') {
      const aOutputs = this.visibleAOutputs;
      const idx = aOutputs.indexOf(physicalIndex);
      return idx >= 0 ? idx : -1;
    } else {
      const bOutputs = this.visibleBOutputs;
      const idx = bOutputs.indexOf(physicalIndex);
      return idx >= 0 ? this.visibleAOutputs.length + idx : -1;
    }
  }

  getInputLabels() {
    const labels = {};
    const aInputs = this.visibleAInputs;
    const bInputs = this.visibleBInputs;

    for (let v = 0; v < aInputs.length; v++) {
      const p = aInputs[v];
      labels[v] = this.routerA.inputLabels[p] || `Input ${p + 1}`;
    }
    for (let v = 0; v < bInputs.length; v++) {
      const p = bInputs[v];
      labels[aInputs.length + v] = this.routerB.inputLabels[p] || `Input ${p + 1}`;
    }
    return labels;
  }

  getOutputLabels() {
    const labels = {};
    const aOutputs = this.visibleAOutputs;
    const bOutputs = this.visibleBOutputs;

    for (let v = 0; v < aOutputs.length; v++) {
      const p = aOutputs[v];
      labels[v] = this.routerA.outputLabels[p] || `Output ${p + 1}`;
    }
    for (let v = 0; v < bOutputs.length; v++) {
      const p = bOutputs[v];
      labels[aOutputs.length + v] = this.routerB.outputLabels[p] || `Output ${p + 1}`;
    }
    return labels;
  }

  // Which router does each virtual input/output belong to?
  getInputRouterMap() {
    const map = {};
    const aCount = this.visibleAInputs.length;
    const bCount = this.visibleBInputs.length;
    for (let i = 0; i < aCount; i++) map[i] = 'A';
    for (let i = 0; i < bCount; i++) map[aCount + i] = 'B';
    return map;
  }

  getOutputRouterMap() {
    const map = {};
    const aCount = this.visibleAOutputs.length;
    const bCount = this.visibleBOutputs.length;
    for (let i = 0; i < aCount; i++) map[i] = 'A';
    for (let i = 0; i < bCount; i++) map[aCount + i] = 'B';
    return map;
  }

  // Build virtual routing table from physical routing + tie-line state
  getVirtualRouting() {
    const routing = {};
    const aOutputs = this.visibleAOutputs;
    const bOutputs = this.visibleBOutputs;

    // Router A outputs
    for (let v = 0; v < aOutputs.length; v++) {
      const physOut = aOutputs[v];
      const physIn = this.routerA.routing[physOut];
      if (physIn === undefined) continue;

      // Check if this input is a B→A tie-line input
      const bToATieLine = this.tieLineState.bToA.find(
        tl => tl.routerAInput === physIn && tl.status === 'in-use'
      );
      if (bToATieLine) {
        // Source is on Router B, coming through tie-line
        const virtualInput = this.physicalInputToVirtual('B', bToATieLine.sourceInput);
        if (virtualInput >= 0) routing[v] = virtualInput;
      } else {
        // Direct Router A input
        const virtualInput = this.physicalInputToVirtual('A', physIn);
        if (virtualInput >= 0) routing[v] = virtualInput;
      }
    }

    // Router B outputs
    for (let v = 0; v < bOutputs.length; v++) {
      const virtualOut = aOutputs.length + v;
      const physOut = bOutputs[v];
      const physIn = this.routerB.routing[physOut];
      if (physIn === undefined) continue;

      // Check if this input is an A→B tie-line input
      const aToBTieLine = this.tieLineState.aToB.find(
        tl => tl.routerBInput === physIn && tl.status === 'in-use'
      );
      if (aToBTieLine) {
        // Source is on Router A, coming through tie-line
        const virtualInput = this.physicalInputToVirtual('A', aToBTieLine.sourceInput);
        if (virtualInput >= 0) routing[virtualOut] = virtualInput;
      } else {
        // Direct Router B input
        const virtualInput = this.physicalInputToVirtual('B', physIn);
        if (virtualInput >= 0) routing[virtualOut] = virtualInput;
      }
    }

    return routing;
  }

  getOutputLocks() {
    const locks = {};
    const aOutputs = this.visibleAOutputs;
    const bOutputs = this.visibleBOutputs;

    for (let v = 0; v < aOutputs.length; v++) {
      const p = aOutputs[v];
      locks[v] = this.routerA.outputLocks?.[p] || 'U';
    }
    for (let v = 0; v < bOutputs.length; v++) {
      const p = bOutputs[v];
      locks[aOutputs.length + v] = this.routerB.outputLocks?.[p] || 'U';
    }
    return locks;
  }

  // Build map of virtual index -> physical port number (1-based) for display
  getInputPhysicalIndices() {
    const indices = {};
    const aInputs = this.visibleAInputs;
    const bInputs = this.visibleBInputs;
    for (let v = 0; v < aInputs.length; v++) indices[v] = aInputs[v] + 1;
    for (let v = 0; v < bInputs.length; v++) indices[aInputs.length + v] = bInputs[v] + 1;
    return indices;
  }

  getOutputPhysicalIndices() {
    const indices = {};
    const aOutputs = this.visibleAOutputs;
    const bOutputs = this.visibleBOutputs;
    for (let v = 0; v < aOutputs.length; v++) indices[v] = aOutputs[v] + 1;
    for (let v = 0; v < bOutputs.length; v++) indices[aOutputs.length + v] = bOutputs[v] + 1;
    return indices;
  }

  // Get complete virtual state object (similar shape to controller getState())
  getState() {
    return {
      inputs: this.totalInputs,
      outputs: this.totalOutputs,
      routing: this.getVirtualRouting(),
      inputLabels: this.getInputLabels(),
      outputLabels: this.getOutputLabels(),
      outputLocks: this.getOutputLocks(),
      inputRouterMap: this.getInputRouterMap(),
      outputRouterMap: this.getOutputRouterMap(),
      inputPhysicalIndices: this.getInputPhysicalIndices(),
      outputPhysicalIndices: this.getOutputPhysicalIndices(),
      routerAInputCount: this.visibleAInputs.length,
      routerBInputCount: this.visibleBInputs.length,
      routerAOutputCount: this.visibleAOutputs.length,
      routerBOutputCount: this.visibleBOutputs.length
    };
  }
}

module.exports = VirtualRouter;
