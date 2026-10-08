var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { HttpRequestExecutor } from "./http-loader.js";
import { P2PLoadersContainer } from "./p2p/loaders-container.js";
import { RequestsContainer } from "./requests/request-container.js";
import { EngineRequest } from "./requests/engine-request.js";
import * as QueueUtils from "./utils/queue.js";
import * as LoggerUtils from "./utils/logger.js";
import * as StreamUtils from "./utils/stream.js";
import * as Utils from "./utils/utils.js";
import debug from "debug";
import { EDGE_RECHECK_MS, SLOW_WINDOW_MS, drawUrgentDelay, edgeSource, nextEdgeEpisode, transferIsSlow, hostSlotVictim, urgentBudgetMs, urgentContext, urgentSource, noteHostAsk as recordHostAsk } from "./urgent-source.mjs"; // wa-patch: use the product's urgent-load decisions and ask record
import { controlInForce } from "../../public/lib/edge-control.mjs"; // wa-patch: read the selected queue control
import { edgeRank, spreadChoice, SPREAD_START_ANYWAY_MS } from "../../public/lib/edge-assignment.mjs"; // wa-patch: call the pure assignment helpers
import { READY_HELD_AHEAD_MS } from "../../public/lib/hold-resume.mjs"; // wa-patch: use the shared near-runway bound
const FAILED_ATTEMPTS_CLEAR_INTERVAL = 60000;
const PEER_UPDATE_LATENCY = 1000;
export class HybridLoader {
    constructor(streamManifestUrl, lastRequestedSegment, streamDetails, config, bandwidthCalculators, segmentStorage, webTorrentSocketPool, eventTarget, peerId) {
        var _a;
        Object.defineProperty(this, "streamManifestUrl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: streamManifestUrl
        });
        Object.defineProperty(this, "lastRequestedSegment", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: lastRequestedSegment
        });
        Object.defineProperty(this, "streamDetails", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: streamDetails
        });
        Object.defineProperty(this, "config", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: config
        });
        Object.defineProperty(this, "bandwidthCalculators", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: bandwidthCalculators
        });
        Object.defineProperty(this, "segmentStorage", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: segmentStorage
        });
        Object.defineProperty(this, "webTorrentSocketPool", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: webTorrentSocketPool
        });
        Object.defineProperty(this, "eventTarget", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: eventTarget
        });
        Object.defineProperty(this, "peerId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: peerId
        });
        Object.defineProperty(this, "edgeControl", { enumerable: true, configurable: true, writable: true, value: controlInForce().control }); // wa-patch: read the control once per loader
        Object.defineProperty(this, "requests", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "engineRequest", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "p2pLoaders", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "playback", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "segmentAvgDuration", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "logger", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "levelChangedTimestamp", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "lastQueueProcessingTimeStamp", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "randomHttpDownloadTimeout", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "initialHttpDelayTimeoutId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "urgentWaits", { enumerable: true, configurable: true, writable: true, value: new Map() }); // wa-patch: one wait episode per segment
        Object.defineProperty(this, "isProcessQueueMicrotaskCreated", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "swarmId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "createdAt", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: performance.now()
        });
        Object.defineProperty(this, "requestProcessQueueMicrotask", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (force = true) => {
                const now = performance.now();
                if ((!force &&
                    this.lastQueueProcessingTimeStamp !== undefined &&
                    now - this.lastQueueProcessingTimeStamp <= 1000) ||
                    this.isProcessQueueMicrotaskCreated) {
                    return;
                }
                this.isProcessQueueMicrotaskCreated = true;
                Utils.queueMicrotask(() => {
                    try {
                        this.processQueue();
                        this.lastQueueProcessingTimeStamp = now;
                    }
                    finally {
                        this.isProcessQueueMicrotaskCreated = false;
                    }
                });
            }
        });
        const activeStream = this.lastRequestedSegment.stream;
        this.swarmId = (_a = this.config.swarmId) !== null && _a !== void 0 ? _a : this.streamManifestUrl;
        this.playback = { position: this.lastRequestedSegment.startTime, rate: 1 };
        this.segmentAvgDuration = StreamUtils.getSegmentAvgDuration(activeStream);
        this.requests = new RequestsContainer(this.requestProcessQueueMicrotask, this.bandwidthCalculators, this.playback, this.config, this.eventTarget, this.swarmId);
        this.p2pLoaders = new P2PLoadersContainer(this.streamManifestUrl, this.lastRequestedSegment.stream, this.requests, this.segmentStorage, this.config, this.webTorrentSocketPool, this.eventTarget, this.peerId, this.requestProcessQueueMicrotask);
        this.logger = debug(`p2pml-core:hybrid-loader-${activeStream.type}`);
        this.logger.color = "coral";
        this.setIntervalLoading();
    }
    setIntervalLoading() {
        const peersCount = this.p2pLoaders.currentLoader.connectedPeerCount;
        const randomTimeout = Math.random() * PEER_UPDATE_LATENCY * peersCount + PEER_UPDATE_LATENCY;
        this.randomHttpDownloadTimeout = window.setTimeout(() => {
            this.loadRandomThroughHttp();
            this.setIntervalLoading();
        }, randomTimeout);
    }
    // api method for engines
    loadSegment(segment, callbacks) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            this.logger(`requests: ${LoggerUtils.getSegmentString(segment)}`);
            const { stream } = segment;
            if (stream !== this.lastRequestedSegment.stream) {
                this.logger(`stream changed to ${LoggerUtils.getStreamString(stream)}`);
                this.p2pLoaders.changeCurrentLoader(stream);
            }
            this.lastRequestedSegment = segment;
            const streamSwarmId = StreamUtils.getStreamSwarmId(this.swarmId, stream);
            this.segmentStorage.onSegmentRequested(this.swarmId, streamSwarmId, segment.externalId, segment.startTime, segment.endTime, stream.type, this.streamDetails.isLive);
            const engineRequest = new EngineRequest(segment, callbacks);
            try {
                const hasSegment = this.segmentStorage.hasSegment(this.swarmId, streamSwarmId, segment.externalId);
                if (hasSegment) {
                    const data = yield this.segmentStorage.getSegmentData(this.swarmId, streamSwarmId, segment.externalId);
                    if (data) {
                        const { queueDownloadRatio } = this.generateQueue();
                        engineRequest.resolve(data, this.getBandwidth(queueDownloadRatio));
                        return;
                    }
                }
                (_a = this.engineRequest) === null || _a === void 0 ? void 0 : _a.abort();
                this.engineRequest = engineRequest;
                // If the engine explicitly requests a segment that previously failed during
                // background pre-fetching, clear its error history so it can be retried.
                const request = this.requests.get(segment);
                if ((request === null || request === void 0 ? void 0 : request.status) === "failed") {
                    request.failedAttempts.clear();
                }
            }
            catch (error) {
                this.logger(`request failed for ${LoggerUtils.getSegmentString(segment)} in ${LoggerUtils.getStreamString(stream)}`, error);
                engineRequest.reject();
            }
            finally {
                this.requestProcessQueueMicrotask();
            }
        });
    }
    processRequests(queueSegmentIds, queueDownloadRatio) {
        var _a;
        const { stream } = this.lastRequestedSegment;
        const { httpErrorRetries } = this.config;
        const now = performance.now();
        for (const request of this.requests.items()) {
            const { downloadSource: type, status, segment, isHandledByProcessQueue, } = request;
            const engineRequest = ((_a = this.engineRequest) === null || _a === void 0 ? void 0 : _a.segment) === segment
                ? this.engineRequest
                : undefined;
            switch (status) {
                case "loading":
                    if (!queueSegmentIds.has(segment.runtimeId) && !engineRequest) {
                        request.cancel();
                        this.requests.remove(request);
                    }
                    break;
                case "succeed": {
                    if (!type)
                        break;
                    if (type === "http") {
                        this.p2pLoaders.currentLoader.broadcastAnnouncement();
                    }
                    if (engineRequest) {
                        engineRequest.resolve(request.data, this.getBandwidth(queueDownloadRatio));
                        this.engineRequest = undefined;
                    }
                    this.clearUrgentWait(segment); // wa-patch: loading ends the wait episode
                    this.requests.remove(request);
                    this.logger(`succeed: ${LoggerUtils.getSegmentString(segment)} (byteLength: ${request.data.byteLength})`);
                    const streamSwarmId = StreamUtils.getStreamSwarmId(this.swarmId, stream);
                    void this.segmentStorage.storeSegment(this.swarmId, streamSwarmId, segment.externalId, request.data, segment.startTime, segment.endTime, segment.stream.type, this.streamDetails.isLive);
                    break;
                }
                case "failed":
                    if (type === "http" && !isHandledByProcessQueue) {
                        this.p2pLoaders.currentLoader.broadcastAnnouncement();
                    }
                    if (!engineRequest &&
                        !stream.segments.has(request.segment.runtimeId)) {
                        this.requests.remove(request);
                    }
                    if (request.failedAttempts.httpAttemptsCount >= httpErrorRetries &&
                        engineRequest) {
                        this.engineRequest = undefined;
                        engineRequest.reject();
                    }
                    break;
                case "not-started":
                    this.requests.remove(request);
                    break;
                case "aborted":
                    this.requests.remove(request);
                    break;
            }
            request.markHandledByProcessQueue();
            const { lastAttempt } = request.failedAttempts;
            if (lastAttempt &&
                now - lastAttempt.error.timestamp > FAILED_ATTEMPTS_CLEAR_INTERVAL) {
                request.failedAttempts.clear();
            }
        }
    }
    processQueue() {
        var _a, _b, _c;
        const { queue, queueSegmentIds, queueDownloadRatio } = this.generateQueue();
        this.processRequests(queueSegmentIds, queueDownloadRatio);
        const now = performance.now(); // wa-patch: all urgent decisions share this processQueue instant
        this.clearUrgentWaits(queue); // wa-patch: discard waits outside the high-demand window
        const { simultaneousHttpDownloads, simultaneousP2PDownloads, httpErrorRetries, httpDownloadInitialTimeoutMs, } = this.config;
        const timeSinceStart = performance.now() - this.createdAt;
        const isInitialHttpWait = httpDownloadInitialTimeoutMs > 0 &&
            timeSinceStart < httpDownloadInitialTimeoutMs;
        if (isInitialHttpWait) {
            (_a = this.initialHttpDelayTimeoutId) !== null && _a !== void 0 ? _a : (this.initialHttpDelayTimeoutId = window.setTimeout(() => {
                this.initialHttpDelayTimeoutId = undefined;
                this.requestProcessQueueMicrotask();
            }, httpDownloadInitialTimeoutMs - timeSinceStart));
        }
        const { engineRequest } = this;
        if (engineRequest) {
            const { segment } = engineRequest;
            const request = this.requests.get(segment);
            const shouldStartLoadImmediatelyEngineRequest = engineRequest.shouldBeStartedImmediately &&
                engineRequest.status === "pending" &&
                (!request ||
                    request.status === "not-started" ||
                    request.status === "failed" ||
                    request.status === "aborted");
            if (shouldStartLoadImmediatelyEngineRequest) {
                // Don't abort requests when processing engine request
                // to avoid race condition with aborts in the requests queue
                const canLoadThroughHttp = !isInitialHttpWait &&
                    ((_b = request === null || request === void 0 ? void 0 : request.failedAttempts.httpAttemptsCount) !== null && _b !== void 0 ? _b : 0) < httpErrorRetries &&
                    this.requests.executingHttpCount < simultaneousHttpDownloads;
                if (canLoadThroughHttp) {
                    const urgent = queue.find((item) => item.segment.runtimeId === segment.runtimeId)?.statuses.isHighDemand; // wa-patch: keep non-urgent engine requests stock
                    const decision = urgent // wa-patch: branch the engine request by control
                        ? this.edgeControl === "8b" ? this.urgentDecision(segment, request, now) : this.edgeDecision(segment, request, now) // wa-patch: call only the selected control
                        : { source: "http" }; // wa-patch: consult the selected urgent source before HTTP
                    if (decision.source === "p2p") { // wa-patch: a holder serves an urgent engine request
                        const canLoadThroughP2P = this.p2pLoaders.currentLoader.isSegmentLoadedBySomeone(segment) && this.requests.executingP2PCount < simultaneousP2PDownloads; // wa-patch: preserve the P2P slot bound
                        if (canLoadThroughP2P) this.loadThroughP2P(segment); // wa-patch: load from the holder
                    } else if (decision.source === "wait") { // wa-patch: let a peer announcement arrive
                        this.armUrgentWait(segment, decision, now); // wa-patch: wake this segment at its bound
                    } else { // wa-patch: complete the urgent engine-request decision
                        if (urgent) this.noteHostAsk(segment, decision); // wa-patch: record only urgent host asks
                        this.loadThroughHttp(segment); // wa-patch: source rule selected the host
                    } // wa-patch: finish the urgent engine-request source branch
                } // wa-patch: finish the engine-request loading gate
                else { // wa-patch: preserve the stock non-urgent engine-request path
                    const canLoadThroughP2P = this.p2pLoaders.currentLoader.isSegmentLoadedBySomeone(segment) &&
                        this.requests.executingP2PCount < simultaneousP2PDownloads;
                    if (canLoadThroughP2P) {
                        this.loadThroughP2P(segment);
                    } // wa-patch: finish the stock P2P fallback
                } // wa-patch: finish the non-urgent engine-request path
            } // wa-patch: finish the engine-request condition
        } // wa-patch: finish the engine request block
        for (const item of queue) {
            const { statuses, segment } = item;
            const request = this.requests.get(segment);
            if ((request === null || request === void 0 ? void 0 : request.status) === "succeed")
                continue;
            if (statuses.isHighDemand) {
                const urgent = this.edgeControl === "8b" // wa-patch: preserve the archived control's decision path
                    ? this.urgentDecision(segment, request, now) // wa-patch: call the archived pure source
                    : this.edgeDecision(segment, request, now); // wa-patch: decide before either high-demand source
                const canLoadThroughHttp = !isInitialHttpWait &&
                    ((_c = request === null || request === void 0 ? void 0 : request.failedAttempts.httpAttemptsCount) !== null && _c !== void 0 ? _c : 0) < httpErrorRetries;
                if (this.edgeControl !== "8b") { // wa-patch: product control assigns high-demand peers
                    if ((request === null || request === void 0 ? void 0 : request.status) === "loading") { // wa-patch: inspect the product transfer state
                        if (request.downloadSource !== "p2p") continue; // wa-patch: leave an HTTP transfer to the stock request loop
                        if (urgent.source === "move") { // wa-patch: move a slow transfer only after finding a spare holder
                            const choice = this.edgeSpreadChoice(segment, urgent, now, true); // wa-patch: choose a spare holder immediately
                            const peer = choice.holderId ? this.findEdgePeer(choice.holderId) : undefined; // wa-patch: resolve the chosen engine peer
                            if (peer && peer.downloadingSegment === undefined) { // wa-patch: check availability before cancelling bytes
                                request.cancel(); // wa-patch: keep bytes before the synchronous re-issue
                                peer.downloadSegment(request); // wa-patch: re-issue on the selected peer in this step
                                this.resetEdgeTransfer(segment, now); // wa-patch: restart the slow sample window after a move
                            } // wa-patch: finish the availability check
                            continue; // wa-patch: a blocked move waits for the next pass
                        } // wa-patch: finish the move branch
                        if (urgent.source === "p2p") { // wa-patch: retain the transfer while it is healthy or awaiting its wake
                            if (Number.isFinite(urgent.wakeMs)) this.armUrgentWait(segment, urgent, now); // wa-patch: wake a slow sole-holder transfer
                            continue; // wa-patch: never fall through while a peer load runs
                        } // wa-patch: finish the peer-retain branch
                        if (urgent.source === "http") { // wa-patch: only the slow-holder fallback reaches HTTP
                            const shouldSwitchFromP2PToHttp = canLoadThroughHttp && // wa-patch: gate the slow-holder fallback
                                (this.requests.executingHttpCount < simultaneousHttpDownloads || // wa-patch: retain the HTTP slot test
                                    this.edgeFreeHostSlot(queue, segment)); // wa-patch: free a slot without cancelling a high-demand host load
                            if (shouldSwitchFromP2PToHttp) { // wa-patch: switch only when an HTTP slot exists
                                request.cancel(); // wa-patch: preserve bytes before the host re-issue
                                this.noteHostAsk(segment, urgent); // wa-patch: record the slow-holder fallback
                                this.loadThroughHttp(segment); // wa-patch: switch in the same queue pass
                            } // wa-patch: finish the host switch
                        } // wa-patch: finish the slow-holder answer
                        continue; // wa-patch: close the product loading branch
                    } // wa-patch: finish the product loading branch
                    if (urgent.source === "wait") { // wa-patch: wait for a holder or the staged deadline
                        this.armUrgentWait(segment, urgent, now); // wa-patch: one timer re-enters processQueue
                        continue; // wa-patch: do not issue the host request yet
                    } // wa-patch: finish the holder choice
                    if (urgent.source === "p2p") { // wa-patch: spread a near-zone request over available holders
                        const choice = this.edgeSpreadChoice(segment, urgent, now, false); // wa-patch: apply the episode's holder rise
                        if (choice.holderId) { // wa-patch: start when a holder is assigned
                            const peer = this.findEdgePeer(choice.holderId); // wa-patch: resolve the chosen engine peer
                            const available = peer && peer.downloadingSegment === undefined; // wa-patch: busy peers are never selected
                            const canLoadThroughP2P = available && // wa-patch: require an available holder
                                (this.requests.executingP2PCount < simultaneousP2PDownloads || // wa-patch: preserve the P2P slot test
                                    this.abortLastP2PLoadingInQueueAfterItem(queue, segment)); // wa-patch: preserve today's P2P slot test
                            if (canLoadThroughP2P) peer.downloadSegment(this.requests.getOrCreateRequest(segment)); // wa-patch: start on the assigned holder
                            else this.armUrgentWait(segment, { source: "wait", untilMs: now + EDGE_RECHECK_MS }, now); // wa-patch: retry a transiently unavailable holder
                        } // wa-patch: finish the assigned-holder branch
                        else if (Number.isFinite(choice.waitUntilMs)) { // wa-patch: honor the spread wake
                            this.armUrgentWait(segment, { source: "wait", untilMs: choice.waitUntilMs }, now); // wa-patch: wait for the next holder slot
                        } // wa-patch: finish the spread-wait branch
                        else { // wa-patch: handle busy holders
                            this.armUrgentWait(segment, { source: "wait", untilMs: now + EDGE_RECHECK_MS }, now); // wa-patch: recheck when all holders are busy
                        } // wa-patch: finish the busy-holder branch
                        continue; // wa-patch: never fall through to the host for a peer answer
                    } // wa-patch: finish the product spread branch
                    const shouldLoadThroughHttp = canLoadThroughHttp && // wa-patch: gate the product host answer
                        (this.requests.executingHttpCount < simultaneousHttpDownloads || // wa-patch: retain the HTTP slot test
                            this.edgeFreeHostSlot(queue, segment)); // wa-patch: free a slot without cancelling a high-demand host load
                    if (shouldLoadThroughHttp) { // wa-patch: issue only with an available host slot
                        this.noteHostAsk(segment, urgent); // wa-patch: record the product-control host answer
                        this.loadThroughHttp(segment); // wa-patch: issue the selected host request
                    } // wa-patch: finish the product host branch
                    continue; // wa-patch: close the product high-demand branch
                } // wa-patch: finish product-control assignment
                if ((request === null || request === void 0 ? void 0 : request.status) === "loading") {
                    // High-demand request is loading
                    const shouldSwitchFromP2PToHttp = urgent.source === "http" && canLoadThroughHttp && // wa-patch: switch only when the urgent budget is spent
                        request.downloadSource === "p2p" &&
                        (this.requests.executingHttpCount < simultaneousHttpDownloads ||
                            this.abortLastHttpLoadingInQueueAfterItem(queue, segment));
                    if (shouldSwitchFromP2PToHttp) {
                        request.cancel();
                        this.noteHostAsk(segment, urgent); // wa-patch: record the 8b urgent fallback
                        this.loadThroughHttp(segment);
                    }
                    continue;
                }
                // High-demand request is not loading
                if (urgent.source === "wait") { // wa-patch: a peer may announce this segment before the delay expires
                    this.armUrgentWait(segment, urgent, now); // wa-patch: one timer re-enters processQueue
                    continue; // wa-patch: do not issue the host request yet
                } // wa-patch: close the urgent wait branch
                if (urgent.source === "p2p") { // wa-patch: a loaded peer is preferred over HTTP
                    const canLoadThroughP2P = this.p2pLoaders.currentLoader.isSegmentLoadedBySomeone(segment) && // wa-patch: preserve stock slot accounting
                        (this.requests.executingP2PCount < simultaneousP2PDownloads || // wa-patch: preserve stock slot accounting
                            this.abortLastP2PLoadingInQueueAfterItem(queue, segment)); // wa-patch: preserve stock queue eviction
                    if (canLoadThroughP2P) this.loadThroughP2P(segment); // wa-patch: load from the holder
                    continue; // wa-patch: never fall through to host for a peer decision
                } // wa-patch: close the urgent holder branch
                const shouldLoadThroughHttp = canLoadThroughHttp &&
                    (this.requests.executingHttpCount < simultaneousHttpDownloads ||
                        this.abortLastHttpLoadingInQueueAfterItem(queue, segment));
                if (shouldLoadThroughHttp) {
                    this.noteHostAsk(segment, urgent); // wa-patch: record the 8b urgent host load
                    this.loadThroughHttp(segment);
                    continue;
                } // wa-patch: close the urgent host-load guard
            } // wa-patch: close the high-demand branch
            else { // wa-patch: preserve the regular request path
                // Regular requests load via P2P only (random HTTP loading also runs by interval)
                const canLoadThroughP2P = statuses.isP2PDownloadable &&
                    (request === null || request === void 0 ? void 0 : request.status) !== "loading" &&
                    this.requests.executingP2PCount < simultaneousP2PDownloads;
                if (canLoadThroughP2P) {
                    this.loadThroughP2P(segment);
                } // wa-patch: close the regular P2P load guard
            } // wa-patch: close the regular request branch
        }
    }
    urgentDecision(segment, request, nowMs) { // wa-patch: adapt pinned peer announcements to the pure rule
        const statuses = [...this.p2pLoaders.currentLoader.peers()].map((peer) => peer.getSegmentStatus(segment)); // wa-patch: read only the pinned public peer status
        const wait = this.urgentWaits.get(segment.runtimeId) ?? { waitStartMs: nowMs, delayMs: drawUrgentDelay(), timeoutId: undefined, untilMs: undefined }; // wa-patch: draw once per waiting episode
        this.urgentWaits.set(segment.runtimeId, wait); // wa-patch: retain the start and draw across queue passes
        const budgetMs = urgentBudgetMs(segment.startTime * 1000); // wa-patch: the budget runs to this segment's start
        const p2pLoading = request?.status === "loading" && request.downloadSource === "p2p"; // wa-patch: this viewer's own peer load
        wait.p2pStartMs = p2pLoading ? (wait.p2pStartMs ?? nowMs) : undefined; // wa-patch: a peer transfer's budget runs from the pass that first saw it
        const held = urgentContext().held; // wa-patch: a held room leaves a progressing peer transfer alone
        const decision = urgentSource({ nowMs, p2pLoading, holders: statuses.filter((status) => status === "loaded").length, loaders: statuses.filter((status) => status === "http-loading").length, p2pFailed: !p2pLoading && (request?.failedAttempts?.p2pAttemptsCount ?? 0) > 0, held, waitStartMs: wait.waitStartMs, p2pStartMs: wait.p2pStartMs, delayMs: wait.delayMs, budgetMs }); // wa-patch: choose peer, wait or host
        if (p2pLoading && Number.isFinite(decision.wakeMs)) this.armUrgentWait(segment, { source: "wait", untilMs: decision.wakeMs }, nowMs); // wa-patch: wake at the budget's end while it is ahead; a holder's transfer past it arms none
        return decision; // wa-patch: the pure rule's answer
    } // wa-patch: finish the urgent wake helper
    edgeDecision(segment, request, nowMs) { // wa-patch: gather engine state for the product-control rule
        const peers = []; // wa-patch: collect the pure peer shape
        let holders = 0; // wa-patch: count loaded announcements
        let loaders = 0; // wa-patch: count loading announcements
        let sender; // wa-patch: remember the peer serving this viewer
        for (const peer of this.p2pLoaders.currentLoader.peers()) { // wa-patch: read each connected engine peer once
            const status = peer.getSegmentStatus(segment); // wa-patch: read the pinned public status
            if (status === "loaded") holders += 1; // wa-patch: count a holder
            if (status === "http-loading") loaders += 1; // wa-patch: count a loader
            if (peer.downloadingSegment === segment && sender === undefined) sender = peer.id; // wa-patch: identify the current sender
            peers.push({ id: peer.id, loaded: status === "loaded", busy: peer.downloadingSegment !== undefined && peer.downloadingSegment !== segment }); // wa-patch: expose only the pure spread shape
        } // wa-patch: finish peer gathering
        const p2pLoading = request?.status === "loading" && request.downloadSource === "p2p"; // wa-patch: read the viewer's active peer transfer
        const p2pFailed = !p2pLoading && (request?.failedAttempts?.p2pAttemptsCount ?? 0) > 0; // wa-patch: preserve the engine failure signal
        const otherHolders = peers.filter((peer) => peer.loaded && peer.id !== sender).length; // wa-patch: exclude the current sender from a move
        const ctx = urgentContext(); // wa-patch: gather the page's current room context
        const rank = edgeRank({ viewerIds: ctx.viewerIds, selfId: ctx.selfId, segmentIndex: segment.externalId }); // wa-patch: assign this viewer for the segment
        const withinRunway = segment.startTime * 1000 < ctx.ownMediaMs + READY_HELD_AHEAD_MS; // wa-patch: apply the shared near-runway bound
        const wait = this.urgentWaits.get(segment.runtimeId) ?? { waitStartMs: nowMs, delayMs: 0, timeoutId: undefined, untilMs: undefined, episode: null, samples: [], p2pStartMs: undefined }; // wa-patch: retain one product episode per segment
        this.urgentWaits.set(segment.runtimeId, wait); // wa-patch: retain the episode across queue passes
        if (p2pLoading) { // wa-patch: sample only an active peer request
            wait.p2pStartMs = wait.p2pStartMs ?? nowMs; // wa-patch: age a transfer from its first near-zone pass
            wait.samples.push({ atMs: nowMs, bytes: request.loadedBytes }); // wa-patch: sample the engine's loaded byte counter
            const cutoffMs = nowMs - 2 * SLOW_WINDOW_MS; // wa-patch: retain two slow windows for the rate probe
            wait.samples = wait.samples.filter((sample) => sample.atMs >= cutoffMs); // wa-patch: drop stale transfer samples
        } // wa-patch: finish sampling
        else { // wa-patch: clear stale transfer samples
            wait.p2pStartMs = undefined; // wa-patch: a later peer attempt starts a new age
            wait.samples = []; // wa-patch: do not carry samples across peer attempts
        } // wa-patch: finish transfer reset
        const slow = p2pLoading && transferIsSlow({ nowMs, startedMs: wait.p2pStartMs, samples: wait.samples }); // wa-patch: classify the transfer by its sampled rate
        wait.episode = nextEdgeEpisode(wait.episode, { nowMs, holders, loaders, withinRunway, slow }); // wa-patch: advance the pure episode once per pass
        if (p2pLoading) this.armUrgentWait(segment, { source: "wait", untilMs: nowMs + EDGE_RECHECK_MS }, nowMs); // wa-patch: revisit every active peer transfer for samples
        const decision = edgeSource({ nowMs, rank, viewers: ctx.viewerIds.length, held: ctx.held, p2pLoading, p2pFailed, slow, holders, otherHolders, loaders, episode: wait.episode, notBeforeMs: ctx.notBeforeMs }); // wa-patch: call the pure product-control source rule
        return { ...decision, rank, peers, sender, episode: wait.episode }; // wa-patch: return the answer and adapter state
    } // wa-patch: finish the product-control decision adapter
    edgeSpreadChoice(segment, decision, nowMs, immediate) { // wa-patch: adapt the pure spread choice to engine peers
        return spreadChoice({ selfPeerId: this.peerId, peers: decision.peers.filter((peer) => peer.id !== decision.sender), segmentIndex: segment.externalId, nowMs: immediate ? SPREAD_START_ANYWAY_MS : nowMs, holdersRoseMs: immediate ? 0 : decision.episode.holdersRoseMs }); // wa-patch: choose without putting the host in the peer pool
    } // wa-patch: finish the spread adapter
    edgeFreeHostSlot(queue, segment) { // wa-patch: cancel a later host load only where the room loses no host copy
        const later = queue.slice(queue.findIndex((item) => item.segment === segment) + 1); // wa-patch: the stock scan stops at this segment
        const victim = hostSlotVictim(later.map((item) => { // wa-patch: describe each later item for the pure rule
            const request = this.requests.get(item.segment); // wa-patch: read the engine request state
            return { loadingFromHost: (request === null || request === void 0 ? void 0 : request.downloadSource) === "http" && request.status === "loading", highDemand: item.statuses.isHighDemand === true }; // wa-patch: the two facts the rule reads
        })); // wa-patch: finish the description
        if (victim < 0) return false; // wa-patch: no slot is freed; the caller waits for one
        this.requests.get(later[victim].segment).cancel(); // wa-patch: cancel as the stock test does
        return true; // wa-patch: a slot is free
    } // wa-patch: finish the host slot adapter
    findEdgePeer(peerId) { // wa-patch: resolve a pure peer id back to its engine object
        for (const peer of this.p2pLoaders.currentLoader.peers()) { // wa-patch: resolve current peers only
            if (peer.id === peerId) return peer; // wa-patch: return the selected engine peer
        } // wa-patch: finish peer lookup
        return undefined; // wa-patch: the peer disconnected between passes
    } // wa-patch: finish the peer lookup adapter
    resetEdgeTransfer(segment, nowMs) { // wa-patch: reset product transfer sampling after a move
        const wait = this.urgentWaits.get(segment.runtimeId); // wa-patch: read the product episode
        if (!wait) return; // wa-patch: tolerate completion racing a move
        wait.samples = []; // wa-patch: clear the old rate window
        wait.p2pStartMs = nowMs; // wa-patch: age the new peer transfer from its move
    } // wa-patch: finish the transfer reset
    noteHostAsk(segment, decision) { // wa-patch: publish one adapter host-ask record
        const ctx = urgentContext(); // wa-patch: calculate the rank in the current room
        let path = null; // wa-patch: invalid URLs are refused by the ring
        try { // wa-patch: parse the segment URL at the adapter boundary
            path = new URL(segment.url, globalThis.location.origin).pathname; // wa-patch: publish only the URL pathname
        } // wa-patch: finish URL parsing
        catch (_error) { // wa-patch: pass null so the ring reports malformed input
            path = null; // wa-patch: preserve the ring's TypeError boundary
        } // wa-patch: finish malformed URL handling
        recordHostAsk({ index: segment.externalId, path, startMs: segment.startTime * 1000, reason: this.edgeControl === "8b" ? "control-8b" : decision.reason, rank: decision.rank ?? edgeRank({ viewerIds: ctx.viewerIds, selfId: ctx.selfId, segmentIndex: segment.externalId }), atMs: performance.timeOrigin + performance.now() }); // wa-patch: record the exact page-time host boundary
    } // wa-patch: finish the host-ask adapter
    armUrgentWait(segment, decision, nowMs) { // wa-patch: arm the rule's single wake timer
        const wait = this.urgentWaits.get(segment.runtimeId); // wa-patch: the decision created the episode
        const untilMs = decision.source === "wait" ? decision.untilMs : decision.wakeMs; // wa-patch: product transfers use the same single wake slot
        if (!wait || !Number.isFinite(untilMs)) return; // wa-patch: defensive no-op for an answer without a wake
        if (wait.timeoutId !== undefined && wait.untilMs <= untilMs) return; // wa-patch: never duplicate or delay an earlier wake
        if (wait.timeoutId !== undefined) window.clearTimeout(wait.timeoutId); // wa-patch: replace only a later wake
        wait.untilMs = untilMs; // wa-patch: publish the timer boundary in the episode
        wait.timeoutId = window.setTimeout(() => { // wa-patch: re-enter the normal queue
            if (this.urgentWaits.get(segment.runtimeId) !== wait) return; // wa-patch: ignore a stale callback
            wait.timeoutId = undefined; // wa-patch: allow a future wait in this episode
            wait.untilMs = undefined; // wa-patch: clear the armed boundary
            this.requestProcessQueueMicrotask(); // wa-patch: reevaluate the peer and host choices
        }, Math.max(0, untilMs - nowMs)); // wa-patch: fixed fake-clock-friendly delay
    } // wa-patch: finish the urgent wait arming helper
    clearUrgentWait(segment) { // wa-patch: drop a completed segment's timer and state
        const wait = this.urgentWaits.get(segment.runtimeId); // wa-patch: find the episode
        if (!wait) return; // wa-patch: already clear
        if (wait.timeoutId !== undefined) window.clearTimeout(wait.timeoutId); // wa-patch: prevent a post-load wake
        this.urgentWaits.delete(segment.runtimeId); // wa-patch: the next urgent visit gets a new draw
    } // wa-patch: finish the completed-segment cleanup helper
    clearUrgentWaits(queue) { // wa-patch: leave no state for a segment outside high demand
        const active = new Set(queue.filter((item) => item.statuses.isHighDemand).map((item) => item.segment.runtimeId)); // wa-patch: current high-demand ids
        for (const [runtimeId, wait] of this.urgentWaits) { // wa-patch: inspect every episode
            if (active.has(runtimeId)) continue; // wa-patch: retain an urgent episode
            if (wait.timeoutId !== undefined) window.clearTimeout(wait.timeoutId); // wa-patch: cancel its wake
            this.urgentWaits.delete(runtimeId); // wa-patch: clear on window exit
        } // wa-patch: finish clearing stale urgent episodes
    } // wa-patch: finish the urgent window cleanup helper
    // api method for engines
    abortSegmentRequest(segmentRuntimeId) {
        var _a;
        if (((_a = this.engineRequest) === null || _a === void 0 ? void 0 : _a.segment.runtimeId) !== segmentRuntimeId)
            return;
        this.engineRequest.abort();
        this.logger("abort: ", LoggerUtils.getSegmentString(this.engineRequest.segment));
        this.engineRequest = undefined;
        this.requestProcessQueueMicrotask();
    }
    loadThroughHttp(segment) {
        const request = this.requests.getOrCreateRequest(segment);
        const executor = new HttpRequestExecutor(request, this.config, this.eventTarget);
        executor.execute();
        this.p2pLoaders.currentLoader.broadcastAnnouncement();
    }
    loadThroughP2P(segment) {
        this.p2pLoaders.currentLoader.downloadSegment(segment);
    }
    loadRandomThroughHttp() {
        const { httpDownloadInitialTimeoutMs } = this.config;
        const isInitialHttpWait = httpDownloadInitialTimeoutMs > 0 &&
            performance.now() - this.createdAt < httpDownloadInitialTimeoutMs;
        if (isInitialHttpWait)
            return;
        const availableStorageCapacityPercent = this.getAvailableStorageCapacityPercent();
        if (availableStorageCapacityPercent <= 10)
            return;
        const { simultaneousHttpDownloads, httpErrorRetries } = this.config;
        const p2pLoader = this.p2pLoaders.currentLoader;
        if (this.requests.executingHttpCount >= simultaneousHttpDownloads ||
            !p2pLoader.connectedPeerCount) {
            return;
        }
        const segmentsToLoad = [];
        for (const { segment, statuses } of QueueUtils.generateQueue(this.lastRequestedSegment, this.playback, this.config, this.p2pLoaders.currentLoader, availableStorageCapacityPercent)) {
            if (this.edgeControl !== "8b" && statuses.isHighDemand) continue; // wa-patch: product control leaves near-zone asks to the edge rule
            const streamSwarmId = StreamUtils.getStreamSwarmId(this.swarmId, segment.stream);
            if (!statuses.isHttpDownloadable ||
                statuses.isP2PDownloadable ||
                this.segmentStorage.hasSegment(this.swarmId, streamSwarmId, segment.externalId)) {
                continue;
            }
            const request = this.requests.get(segment);
            if (request &&
                (request.status === "loading" ||
                    request.status === "succeed" ||
                    request.failedAttempts.httpAttemptsCount >= httpErrorRetries)) {
                continue;
            }
            segmentsToLoad.push({ segment, isHighDemand: statuses.isHighDemand }); // wa-patch: retain the queue item's demand class for the ask record
        }
        if (!segmentsToLoad.length)
            return;
        const availableHttpDownloads = simultaneousHttpDownloads - this.requests.executingHttpCount;
        if (availableHttpDownloads === 0)
            return;
        const peersCount = p2pLoader.connectedPeerCount + 1;
        const safeRandomSegmentsCount = Math.min(segmentsToLoad.length, simultaneousHttpDownloads * peersCount);
        const randomIndices = Utils.shuffleArray(Array.from({ length: safeRandomSegmentsCount }, (_, i) => i));
        let probability = safeRandomSegmentsCount / peersCount;
        for (const randomIndex of randomIndices) {
            if (this.requests.executingHttpCount >= simultaneousHttpDownloads) {
                break;
            }
            if (probability >= 1 || Math.random() <= probability) {
                const candidate = segmentsToLoad[randomIndex]; // wa-patch: select the stock random candidate
                if (candidate.isHighDemand) this.noteHostAsk(candidate.segment, { rank: undefined }); // wa-patch: record every 8b random near-zone host ask
                this.loadThroughHttp(candidate.segment); // wa-patch: keep the stock random host load
            }
            probability--;
            if (probability <= 0)
                break;
        }
    }
    abortLastHttpLoadingInQueueAfterItem(queue, segment) {
        for (const { segment: itemSegment } of Utils.arrayBackwards(queue)) {
            if (itemSegment === segment)
                break;
            const request = this.requests.get(itemSegment);
            if ((request === null || request === void 0 ? void 0 : request.downloadSource) === "http" && request.status === "loading") {
                request.cancel();
                return true;
            }
        }
        return false;
    }
    abortLastP2PLoadingInQueueAfterItem(queue, segment) {
        for (const { segment: itemSegment } of Utils.arrayBackwards(queue)) {
            if (itemSegment === segment)
                break;
            const request = this.requests.get(itemSegment);
            if ((request === null || request === void 0 ? void 0 : request.downloadSource) === "p2p" && request.status === "loading") {
                request.cancel();
                return true;
            }
        }
        return false;
    }
    getAvailableStorageCapacityPercent() {
        const { totalCapacity, usedCapacity } = this.segmentStorage.getUsage();
        return 100 - (usedCapacity / totalCapacity) * 100;
    }
    generateQueue() {
        var _a;
        const queue = [];
        const queueSegmentIds = new Set();
        let maxPossibleLength = 0;
        let alreadyLoadedCount = 0;
        const availableStorageCapacityPercent = this.getAvailableStorageCapacityPercent();
        for (const item of QueueUtils.generateQueue(this.lastRequestedSegment, this.playback, this.config, this.p2pLoaders.currentLoader, availableStorageCapacityPercent)) {
            maxPossibleLength++;
            const { segment } = item;
            const streamSwarmId = StreamUtils.getStreamSwarmId(this.swarmId, segment.stream);
            if (this.segmentStorage.hasSegment(this.swarmId, streamSwarmId, segment.externalId) ||
                ((_a = this.requests.get(segment)) === null || _a === void 0 ? void 0 : _a.status) === "succeed") {
                alreadyLoadedCount++;
                continue;
            }
            queue.push(item);
            queueSegmentIds.add(segment.runtimeId);
        }
        return {
            queue,
            queueSegmentIds,
            maxPossibleLength,
            alreadyLoadedCount,
            queueDownloadRatio: maxPossibleLength !== 0 ? alreadyLoadedCount / maxPossibleLength : 0,
        };
    }
    getBandwidth(queueDownloadRatio) {
        const { http, all } = this.bandwidthCalculators;
        const { activeLevelBitrate } = this.streamDetails;
        if (activeLevelBitrate === 0) {
            return all.getBandwidthLoadingOnly(3);
        }
        const bandwidth = Math.max(all.getBandwidth(30, this.levelChangedTimestamp), all.getBandwidth(60, this.levelChangedTimestamp), all.getBandwidth(90, this.levelChangedTimestamp));
        if (queueDownloadRatio >= 0.8 || bandwidth >= activeLevelBitrate * 0.9) {
            return Math.max(all.getBandwidthLoadingOnly(1), all.getBandwidthLoadingOnly(3), all.getBandwidthLoadingOnly(5));
        }
        const httpRealBandwidth = Math.max(http.getBandwidthLoadingOnly(1), http.getBandwidthLoadingOnly(3), http.getBandwidthLoadingOnly(5));
        return Math.max(bandwidth, httpRealBandwidth);
    }
    notifyLevelChanged() {
        this.levelChangedTimestamp = performance.now();
    }
    sendBroadcastAnnouncement(sendEmptySegmentsAnnouncement = false) {
        this.p2pLoaders.currentLoader.broadcastAnnouncement(sendEmptySegmentsAnnouncement);
    }
    updatePlayback(position, rate) {
        var _a;
        const isRateChanged = this.playback.rate !== rate;
        const isPositionChanged = this.playback.position !== position;
        if (!isRateChanged && !isPositionChanged)
            return;
        const isPositionSignificantlyChanged = Math.abs(position - this.playback.position) / this.segmentAvgDuration >
            0.5;
        if (isPositionChanged)
            this.playback.position = position;
        if (isRateChanged && rate !== 0)
            this.playback.rate = rate;
        if (isPositionSignificantlyChanged) {
            this.logger("position significantly changed");
            (_a = this.engineRequest) === null || _a === void 0 ? void 0 : _a.markAsShouldBeStartedImmediately();
        }
        this.segmentStorage.onPlaybackUpdated(position, rate);
        this.requestProcessQueueMicrotask(isPositionSignificantlyChanged);
    }
    updateStream(stream) {
        if (stream !== this.lastRequestedSegment.stream)
            return;
        this.logger(`update stream: ${LoggerUtils.getStreamString(stream)}`);
        this.requestProcessQueueMicrotask();
    }
    destroy() {
        var _a;
        clearTimeout(this.randomHttpDownloadTimeout);
        clearTimeout(this.initialHttpDelayTimeoutId);
        for (const wait of this.urgentWaits.values()) if (wait.timeoutId !== undefined) window.clearTimeout(wait.timeoutId); // wa-patch: cancel urgent wakes
        this.urgentWaits.clear(); // wa-patch: release urgent state
        (_a = this.engineRequest) === null || _a === void 0 ? void 0 : _a.abort();
        this.requests.destroy();
        this.p2pLoaders.destroy();
    }
}
//# sourceMappingURL=hybrid-loader.js.map
