export function createHostAnswer({ client, RTCPeerConnection, rtcConfig, origin, isActive, report } = {}) {
  const peers = new Map();

  function close(viewerId) {
    const entry = peers.get(viewerId);
    if (!entry) return;
    peers.delete(viewerId);
    try { entry.detach?.(); } catch (error) { report('host link detach', error); }
    try { entry.pc.close(); } catch (error) { report('host link close', error); }
  }

  function closeAll() {
    for (const viewerId of [...peers.keys()]) close(viewerId);
  }

  function closeDeparted(roster) {
    const present = new Set((roster ?? []).map((member) => member.clientId));
    for (const viewerId of peers.keys()) {
      if (!present.has(viewerId)) close(viewerId);
    }
  }

  async function answerOffer(env) {
    if (!isActive()) return;
    const viewerId = env.from;
    const payload = env.payload ?? {};
    if (typeof viewerId !== 'string' || typeof payload.linkId !== 'string' || typeof payload.sdp !== 'string') {
      throw new TypeError('host-link-offer is malformed');
    }
    close(viewerId);
    const pc = new RTCPeerConnection(rtcConfig());
    const viewerTag = client.roster.find((member) => member.clientId === viewerId)?.tabId ?? null;
    const entry = { pc, linkId: payload.linkId, viewerTag, detach: null };
    peers.set(viewerId, entry);
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate || peers.get(viewerId) !== entry) return;
      const candidate = typeof event.candidate.toJSON === 'function' ? event.candidate.toJSON() : event.candidate;
      client.send({ type: 'host-link-ice', to: viewerId, payload: { linkId: entry.linkId, candidate } });
    });
    pc.addEventListener('datachannel', (event) => {
      const hostOrigin = origin();
      if (peers.get(viewerId) !== entry || !hostOrigin) return;
      entry.detach?.();
      entry.detach = hostOrigin.attach(event.channel, { viewerTag: entry.viewerTag });
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    client.send({ type: 'host-link-answer', to: viewerId, payload: { linkId: entry.linkId, sdp: answer.sdp ?? answer } });
  }

  async function routeIce(env) {
    if (!isActive()) return;
    const entry = peers.get(env.from);
    if (!entry || env.payload?.linkId !== entry.linkId) return;
    await entry.pc.addIceCandidate(env.payload.candidate);
  }

  return {
    answerOffer,
    routeIce,
    close,
    closeAll,
    closeDeparted,
    peerConnections: () => [...peers.values()].map((entry) => entry.pc),
  };
}
