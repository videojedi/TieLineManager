const EventEmitter = require('events');

class TieLineEngine extends EventEmitter {
  constructor(controllerA, controllerB, tieLineConfig) {
    super();
    this.controllerA = controllerA;
    this.controllerB = controllerB;
    this.config = tieLineConfig || { aToB: [], bToA: [] };
    this.state = { aToB: [], bToA: [] };
    this.initializeState();
  }

  initializeState() {
    this.state.aToB = this.config.aToB.map((tl, idx) => ({
      index: idx,
      routerAOutput: tl.routerAOutput,
      routerBInput: tl.routerBInput,
      status: 'free',
      sourceInput: null,
      destinations: []
    }));
    this.state.bToA = this.config.bToA.map((tl, idx) => ({
      index: idx,
      routerBOutput: tl.routerBOutput,
      routerAInput: tl.routerAInput,
      status: 'free',
      sourceInput: null,
      destinations: []
    }));
  }

  updateConfig(tieLineConfig) {
    this.config = tieLineConfig;
    this.initializeState();
    if (this.controllerA?.isConnected() && this.controllerB?.isConnected()) {
      this.reconstructStateFromRouting();
    }
    this.emit('state-changed', this.state);
  }

  getState() {
    return {
      aToB: this.state.aToB.map(tl => ({ ...tl, destinations: [...tl.destinations] })),
      bToA: this.state.bToA.map(tl => ({ ...tl, destinations: [...tl.destinations] }))
    };
  }

  // Top-level route dispatcher
  async executeVirtualRoute(virtualOutput, virtualInput, virtualRouter, level = 0) {
    const source = virtualRouter.resolveInput(virtualInput);
    const dest = virtualRouter.resolveOutput(virtualOutput);

    if (!source || !dest) {
      return { success: false, error: 'Invalid virtual index' };
    }

    // Same router — direct route, no tie-lines needed
    if (source.router === dest.router) {
      // First, clean up any tie-line this output was previously using
      await this._cleanupOutputTieLine(source.router, dest.router, dest.physicalIndex);
      return this._routeDirect(source.router, source.physicalIndex, dest.physicalIndex, level);
    }

    // Cross-router routing
    if (source.router === 'A' && dest.router === 'B') {
      await this._handleOutputReassignment('aToB', dest.physicalIndex);
      return this._routeAToB(source.physicalIndex, dest.physicalIndex, level);
    }

    if (source.router === 'B' && dest.router === 'A') {
      await this._handleOutputReassignment('bToA', dest.physicalIndex);
      return this._routeBToA(source.physicalIndex, dest.physicalIndex, level);
    }

    return { success: false, error: 'Unknown routing scenario' };
  }

  // Direct route within the same router
  async _routeDirect(router, sourceInput, destOutput, level) {
    try {
      const controller = router === 'A' ? this.controllerA : this.controllerB;
      if (!controller?.isConnected()) {
        return { success: false, error: `Router ${router} is not connected` };
      }
      await controller.setRoute(destOutput, sourceInput, level);
      this.emit('state-changed', this.state);
      return { success: true, direct: true };
    } catch (err) {
      return { success: false, error: `Router ${router} route failed: ${err.message}` };
    }
  }

  // Route Router A source to Router B destination via tie-line
  async _routeAToB(sourceInput, destOutput, level) {
    if (!this.controllerA?.isConnected()) {
      return { success: false, error: 'Router A is not connected' };
    }
    if (!this.controllerB?.isConnected()) {
      return { success: false, error: 'Router B is not connected' };
    }

    // Check if source is already on a tie-line (reuse)
    let tieLine = this.state.aToB.find(
      tl => tl.status === 'in-use' && tl.sourceInput === sourceInput
    );

    if (tieLine) {
      // Reuse existing tie-line — just route on Router B side
      try {
        await this.controllerB.setRoute(destOutput, tieLine.routerBInput, level);
        if (!tieLine.destinations.includes(destOutput)) {
          tieLine.destinations.push(destOutput);
        }
        this.emit('state-changed', this.state);
        return { success: true, tieLineIndex: tieLine.index, reused: true };
      } catch (err) {
        return { success: false, error: `Router B route failed: ${err.message}` };
      }
    }

    // Need a new tie-line
    tieLine = this.state.aToB.find(tl => tl.status === 'free');
    if (!tieLine) {
      const total = this.state.aToB.length;
      return {
        success: false,
        error: `All A→B tie-lines are in use (${total}/${total}). Cannot route across routers.`
      };
    }

    // Step 1: Route source to tie-line output on Router A
    try {
      await this.controllerA.setRoute(tieLine.routerAOutput, sourceInput, level);
    } catch (err) {
      return { success: false, error: `Router A route failed: ${err.message}` };
    }

    // Step 2: Route tie-line input to destination on Router B
    try {
      await this.controllerB.setRoute(destOutput, tieLine.routerBInput, level);
    } catch (err) {
      return {
        success: false,
        error: `Router B route failed: ${err.message}. Router A was routed but Router B failed.`,
        partialFailure: true
      };
    }

    // Both succeeded
    tieLine.status = 'in-use';
    tieLine.sourceInput = sourceInput;
    tieLine.destinations = [destOutput];
    this.emit('state-changed', this.state);
    return { success: true, tieLineIndex: tieLine.index, reused: false };
  }

  // Route Router B source to Router A destination via tie-line (symmetric)
  async _routeBToA(sourceInput, destOutput, level) {
    if (!this.controllerB?.isConnected()) {
      return { success: false, error: 'Router B is not connected' };
    }
    if (!this.controllerA?.isConnected()) {
      return { success: false, error: 'Router A is not connected' };
    }

    // Check if source is already on a tie-line (reuse)
    let tieLine = this.state.bToA.find(
      tl => tl.status === 'in-use' && tl.sourceInput === sourceInput
    );

    if (tieLine) {
      try {
        await this.controllerA.setRoute(destOutput, tieLine.routerAInput, level);
        if (!tieLine.destinations.includes(destOutput)) {
          tieLine.destinations.push(destOutput);
        }
        this.emit('state-changed', this.state);
        return { success: true, tieLineIndex: tieLine.index, reused: true };
      } catch (err) {
        return { success: false, error: `Router A route failed: ${err.message}` };
      }
    }

    // Need a new tie-line
    tieLine = this.state.bToA.find(tl => tl.status === 'free');
    if (!tieLine) {
      const total = this.state.bToA.length;
      return {
        success: false,
        error: `All B→A tie-lines are in use (${total}/${total}). Cannot route across routers.`
      };
    }

    // Step 1: Route source to tie-line output on Router B
    try {
      await this.controllerB.setRoute(tieLine.routerBOutput, sourceInput, level);
    } catch (err) {
      return { success: false, error: `Router B route failed: ${err.message}` };
    }

    // Step 2: Route tie-line input to destination on Router A
    try {
      await this.controllerA.setRoute(destOutput, tieLine.routerAInput, level);
    } catch (err) {
      return {
        success: false,
        error: `Router A route failed: ${err.message}. Router B was routed but Router A failed.`,
        partialFailure: true
      };
    }

    tieLine.status = 'in-use';
    tieLine.sourceInput = sourceInput;
    tieLine.destinations = [destOutput];
    this.emit('state-changed', this.state);
    return { success: true, tieLineIndex: tieLine.index, reused: false };
  }

  // Clean up tie-line when an output is being re-routed to a same-router source
  async _cleanupOutputTieLine(sourceRouter, destRouter, destPhysicalOutput) {
    // If this output was previously using a cross-router tie-line, release it
    if (destRouter === 'A') {
      // Was this output using a B→A tie-line?
      const tieLine = this.state.bToA.find(
        tl => tl.status === 'in-use' && tl.destinations.includes(destPhysicalOutput)
      );
      if (tieLine) {
        this._releaseTieLineDestination('bToA', tieLine.index, destPhysicalOutput);
      }
    } else {
      // Was this output using an A→B tie-line?
      const tieLine = this.state.aToB.find(
        tl => tl.status === 'in-use' && tl.destinations.includes(destPhysicalOutput)
      );
      if (tieLine) {
        this._releaseTieLineDestination('aToB', tieLine.index, destPhysicalOutput);
      }
    }
  }

  // When re-routing an output that was previously cross-router
  async _handleOutputReassignment(direction, destOutput) {
    const pool = this.state[direction];
    const oldTieLine = pool.find(
      tl => tl.status === 'in-use' && tl.destinations.includes(destOutput)
    );
    if (oldTieLine) {
      this._releaseTieLineDestination(direction, oldTieLine.index, destOutput);
    }
  }

  _releaseTieLineDestination(direction, tieLineIndex, removedDest) {
    const pool = this.state[direction];
    const tieLine = pool[tieLineIndex];
    if (!tieLine || tieLine.status !== 'in-use') return;

    tieLine.destinations = tieLine.destinations.filter(d => d !== removedDest);

    if (tieLine.destinations.length === 0) {
      tieLine.status = 'free';
      tieLine.sourceInput = null;
    }
    this.emit('state-changed', this.state);
  }

  // Release all tie-lines back to free state
  releaseAllTieLines() {
    for (const tieLine of this.state.aToB) {
      tieLine.status = 'free';
      tieLine.sourceInput = null;
      tieLine.destinations = [];
    }
    for (const tieLine of this.state.bToA) {
      tieLine.status = 'free';
      tieLine.sourceInput = null;
      tieLine.destinations = [];
    }
    this.emit('state-changed', this.state);
  }

  // Reconstruct tie-line state from current physical routing
  reconstructStateFromRouting() {
    if (!this.controllerA?.isConnected() || !this.controllerB?.isConnected()) return;

    const routingA = this.controllerA.getState().routing;
    const routingB = this.controllerB.getState().routing;

    // Build sets of all tie-line ports so we can exclude them as destinations
    const tieLineAOutputs = new Set(this.config.aToB.map(tl => tl.routerAOutput));
    const tieLineBOutputs = new Set(this.config.bToA.map(tl => tl.routerBOutput));
    const tieLineBInputs = new Set(this.config.aToB.map(tl => tl.routerBInput));
    const tieLineAInputs = new Set(this.config.bToA.map(tl => tl.routerAInput));

    // Check A→B tie-lines
    for (const tieLine of this.state.aToB) {
      const sourceOnA = routingA[tieLine.routerAOutput];
      const destsOnB = [];
      for (const [output, input] of Object.entries(routingB)) {
        const outIdx = parseInt(output);
        // Only count outputs that are routed to this tie-line input AND are
        // not themselves tie-line ports AND are not just default 1:1 routing
        if (parseInt(input) === tieLine.routerBInput
            && !tieLineBOutputs.has(outIdx)
            && outIdx !== parseInt(input)) {
          destsOnB.push(outIdx);
        }
      }

      if (sourceOnA !== undefined && destsOnB.length > 0) {
        tieLine.status = 'in-use';
        tieLine.sourceInput = sourceOnA;
        tieLine.destinations = destsOnB;
      } else {
        tieLine.status = 'free';
        tieLine.sourceInput = null;
        tieLine.destinations = [];
      }
    }

    // Check B→A tie-lines
    for (const tieLine of this.state.bToA) {
      const sourceOnB = routingB[tieLine.routerBOutput];
      const destsOnA = [];
      for (const [output, input] of Object.entries(routingA)) {
        const outIdx = parseInt(output);
        if (parseInt(input) === tieLine.routerAInput
            && !tieLineAOutputs.has(outIdx)
            && outIdx !== parseInt(input)) {
          destsOnA.push(outIdx);
        }
      }

      if (sourceOnB !== undefined && destsOnA.length > 0) {
        tieLine.status = 'in-use';
        tieLine.sourceInput = sourceOnB;
        tieLine.destinations = destsOnA;
      } else {
        tieLine.status = 'free';
        tieLine.sourceInput = null;
        tieLine.destinations = [];
      }
    }

    this.emit('state-changed', this.state);
  }
}

module.exports = TieLineEngine;
