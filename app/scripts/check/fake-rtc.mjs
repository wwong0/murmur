// Small RTC and room-client doubles shared by host-link checks.  They expose
// the same event and signalling seams as the browser objects, while keeping
// all delivery on fake-channel's deterministic clock.

import { createFakeLink } from './fake-channel.mjs';

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type, value = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn.call(this, value);
    },
  };
}

export function createFakeRoomClient({ clientId = 'viewer-1', roster = [] } = {}) {
  const typeHandlers = new Map();
  const eventHandlers = new Map();
  const client = {
    clientId,
    sent: [],
    roster,
    send(message) {
      client.sent.push(message);
      return message;
    },
    on(type, fn) {
      if (!typeHandlers.has(type)) typeHandlers.set(type, new Set());
      typeHandlers.get(type).add(fn);
      return () => typeHandlers.get(type)?.delete(fn);
    },
    onEvent(type, fn) {
      if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
      eventHandlers.get(type).add(fn);
      return () => eventHandlers.get(type)?.delete(fn);
    },
    emit(type, value) {
      if (type === 'presence') client.roster = value?.payload?.roster ?? value?.roster ?? value;
      for (const fn of [...(typeHandlers.get(type) ?? [])]) fn(value);
    },
    emitEvent(type, value) {
      if (type === 'joined') {
        client.roster = value?.roster ?? client.roster;
        client.clientId = value?.clientId ?? client.clientId;
      }
      for (const fn of [...(eventHandlers.get(type) ?? [])]) fn(value);
    },
  };
  return client;
}

/**
 * Build a pair of fake peer connections.  The viewer's created data channel
 * is paired with `hostChannel`, which makes host-origin and host-link tests
 * share one exact transport model.
 */
export function createFakeRtcPair({ clock, hostChannel, stats = null } = {}) {
  const offered = [];
  const peers = [];
  class FakePeerConnection {
    constructor(config) {
      this.config = config;
      this.connectionState = 'new';
      this.remoteDescription = null;
      this.localDescription = null;
      this._events = events();
      this.channel = null;
      peers.push(this);
    }
    addEventListener(type, fn) { this._events.addEventListener(type, fn); }
    removeEventListener(type, fn) { this._events.removeEventListener(type, fn); }
    emit(type, value) { this._events.emit(type, value); }
    createDataChannel() {
      if (!hostChannel) throw new Error('createFakeRtcPair: hostChannel is required');
      const link = { viewer: null, host: hostChannel };
      // The caller supplies the host end; a fresh viewer channel is made with
      // the same clock and then paired to it through the fake's private seam.
      // Importing here would create a cycle, so the host channel exposes the
      // pair hook as part of fake-channel's test-only surface.
      const viewer = hostChannel._makePeer ? hostChannel._makePeer() : null;
      if (!viewer) throw new Error('host channel was not created by createFakeChannel');
      link.viewer = viewer;
      this.channel = viewer;
      return viewer;
    }
    async createOffer() { return { type: 'offer', sdp: 'fake-offer' }; }
    async setLocalDescription(description) {
      this.localDescription = description;
      offered.push(description);
      this.connectionState = 'connecting';
    }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
      this.connectionState = 'connected';
      this.emit('connectionstatechange', {});
    }
    async addIceCandidate() {}
    async getStats() { return stats ?? new Map(); }
    close() {
      this.connectionState = 'closed';
      this.channel?.close();
      this.emit('connectionstatechange', {});
    }
  }
  return { RTCPeerConnection: FakePeerConnection, peers, offered };
}

/** A factory used when each reconnect needs a fresh fake channel pair. */
export function createFakeRtcFactory({ clock, onLink, stats = null, hostDrainBytesPerMs = 1000, viewerDrainBytesPerMs = 1000 } = {}) {
  const links = [];
  const peers = [];
  class FakePeerConnection {
    constructor(config) {
      this.config = config;
      this.connectionState = 'new';
      this.remoteDescription = null;
      this.localDescription = null;
      this._events = events();
      this.channel = null;
      peers.push(this);
    }
    addEventListener(type, fn) { this._events.addEventListener(type, fn); }
    removeEventListener(type, fn) { this._events.removeEventListener(type, fn); }
    emit(type, value) { this._events.emit(type, value); }
    createDataChannel() {
      const link = createFakeLink({ clock, hostDrainBytesPerMs, viewerDrainBytesPerMs });
      links.push(link);
      this.channel = link.viewer;
      onLink?.(link, this);
      return link.viewer;
    }
    async createOffer() { return { type: 'offer', sdp: 'fake-offer' }; }
    async setLocalDescription(description) { this.localDescription = description; this.connectionState = 'connecting'; }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
      this.connectionState = 'connected';
      this.emit('connectionstatechange', {});
    }
    async addIceCandidate() {}
    async getStats() { return stats ?? new Map(); }
    close() { this.connectionState = 'closed'; this.channel?.close(); this.emit('connectionstatechange', {}); }
  }
  return { RTCPeerConnection: FakePeerConnection, links, peers };
}

export { createFakeLink };
