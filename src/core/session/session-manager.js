import { randomId } from '../../shared/utils/ids.js';
import { nowIso } from '../../shared/utils/time.js';
import { SessionStates } from './session-types.js';
import { transitionSession } from './session-state-machine.js';
import { createRuntimeRequest } from '../../runtime/acp/runtime-request.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';
import { conversationLogPath } from '../../channel/host/conversation-ref.js';
import { shouldRecreateSession } from '../../state/recovery/recovery-policy.js';

export class SessionManager {
  constructor({ stateStore, runtimeGateway, sessionPolicy = {} }) {
    this.stateStore = stateStore;
    this.runtimeGateway = runtimeGateway;
    this.conversationTasks = new Map();
    this.sessionPolicy = {
      idleTtlMinutes: sessionPolicy.idleTtlMinutes ?? 240,
      maxTurnsPerSession: sessionPolicy.maxTurnsPerSession ?? 200
    };
  }

  normalizeSession(session, routeDecision) {
    const bindingState = session.bindingState ?? session.state ?? SessionStates.MISSING;
    const createdAt = session.createdAt ?? session.updatedAt ?? nowIso();
    return {
      ...session,
      conversationKey: routeDecision.conversationKey,
      instanceId: routeDecision.instanceId,
      providerId: routeDecision.providerId,
      agentName: routeDecision.agentName,
      resolvedCwd: routeDecision.resolvedCwd,
      bindingState,
      state: bindingState,
      createdAt,
      lastUsedAt: session.lastUsedAt ?? session.updatedAt ?? createdAt,
      lastRecoveryAt: session.lastRecoveryAt ?? null,
      lastError: session.lastError ?? null,
      conversationLogPath: conversationLogPath({
        dataDir: this.stateStore.dataDir,
        conversationRef: routeDecision.conversationRef
      }),
      turnCount: session.turnCount ?? 0,
      updatedAt: session.updatedAt ?? nowIso()
    };
  }

  isIdleExpired(session) {
    const ttlMinutes = Number(this.sessionPolicy.idleTtlMinutes ?? 0);
    if (!ttlMinutes || !session?.updatedAt) return false;
    return (Date.now() - Date.parse(session.updatedAt)) > (ttlMinutes * 60 * 1000);
  }

  hasReachedTurnLimit(session) {
    const maxTurns = Number(this.sessionPolicy.maxTurnsPerSession ?? 0);
    if (!maxTurns) return false;
    return Number(session?.turnCount ?? 0) >= maxTurns;
  }

  async hydrateStoredSession(existing, routeDecision) {
    if (!existing) return null;
    const normalized = this.normalizeSession(existing, routeDecision);
    if (Number.isFinite(existing.turnCount)) {
      return normalized;
    }
    const countedTurns = normalized.conversationLogPath
      ? await this.stateStore.conversationLog.countRole(normalized.conversationLogPath, 'user')
      : 0;
    return {
      ...normalized,
      turnCount: countedTurns
    };
  }

  async retireSession(session) {
    if (!session?.runtimeHandle) return;
    try {
      await this.runtimeGateway.close({
        agentId: session.agentName,
        runtimeHandle: session.runtimeHandle,
        cwd: session.resolvedCwd ?? session.cwd
      });
    } catch {
      // Old session cleanup should never block session recreation.
    }
  }

  isBindingCompatible(session, routeDecision) {
    return (
      session.instanceId === routeDecision.instanceId &&
      session.providerId === routeDecision.providerId &&
      session.agentName === routeDecision.agentName &&
      session.resolvedCwd === routeDecision.resolvedCwd
    );
  }

  buildRuntimeError(error) {
    return {
      code: error?.code ?? ErrorCodes.RUNTIME_TURN_FAILED,
      message: error?.message ?? String(error),
      layer: 'runtime'
    };
  }

  async persistSessionState(routeDecision, session) {
    const active = this.normalizeSession(session, routeDecision);
    await this.stateStore.runtimeBindingStore.set(routeDecision.conversationRef, active);
    return active;
  }

  async persistFailedSession(routeDecision, session, error) {
    return this.persistSessionState(routeDecision, {
      ...session,
      bindingState: SessionStates.FAILED,
      updatedAt: nowIso(),
      lastUsedAt: session.lastUsedAt ?? session.updatedAt ?? nowIso(),
      lastError: this.buildRuntimeError(error)
    });
  }

  async tryResumeSession(routeDecision, session) {
    if (!session?.runtimeHandle) return null;
    if (typeof this.runtimeGateway.resumeSession !== 'function') {
      return this.normalizeSession({
        ...session,
        bindingState: SessionStates.ACTIVE,
        updatedAt: nowIso(),
        lastError: null
      }, routeDecision);
    }
    try {
      const resumed = await this.runtimeGateway.resumeSession({
        agentId: routeDecision.agentName,
        cwd: routeDecision.resolvedCwd,
        runtimeHandle: session.runtimeHandle
      });
      if (!resumed?.ok || !resumed.runtimeHandle) return null;
      const active = this.normalizeSession({
        ...session,
        runtimeHandle: resumed.runtimeHandle,
        bindingState: SessionStates.ACTIVE,
        updatedAt: nowIso(),
        lastUsedAt: resumed.metadata?.lastUsedAt ?? nowIso(),
        lastRecoveryAt: nowIso(),
        lastError: null
      }, routeDecision);
      await this.stateStore.runtimeBindingStore.set(routeDecision.conversationRef, active);
      return active;
    } catch (error) {
      return this.normalizeSession({
        ...session,
        bindingState: SessionStates.RECOVERING,
        updatedAt: nowIso(),
        lastRecoveryAt: nowIso(),
        lastError: this.buildRuntimeError(error)
      }, routeDecision);
    }
  }

  enqueueConversationTask(conversationKey, task) {
    const previous = this.conversationTasks.get(conversationKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task);
    this.conversationTasks.set(conversationKey, next);
    next.finally(() => {
      if (this.conversationTasks.get(conversationKey) === next) {
        this.conversationTasks.delete(conversationKey);
      }
    });
    return next;
  }

  async getOrCreateSession(routeDecision) {
    const existing = await this.stateStore.runtimeBindingStore.get(routeDecision.conversationRef);
    const hydrated = await this.hydrateStoredSession(existing, routeDecision);
    if (hydrated) {
      if (!this.isBindingCompatible(hydrated, routeDecision)) {
        await this.retireSession(hydrated);
        return this.recreateSession(routeDecision, hydrated);
      }
    }
    if (hydrated?.bindingState === SessionStates.ACTIVE && hydrated.runtimeHandle) {
      if (this.isIdleExpired(hydrated) || this.hasReachedTurnLimit(hydrated)) {
        await this.retireSession(hydrated);
        return this.recreateSession(routeDecision, hydrated);
      }
      const resumed = await this.tryResumeSession(routeDecision, hydrated);
      if (resumed?.bindingState === SessionStates.ACTIVE) {
        return resumed;
      }
      return this.recreateSession(routeDecision, resumed ?? hydrated);
    }

    if (
      hydrated?.runtimeHandle &&
      (hydrated.bindingState === SessionStates.RECOVERING || hydrated.bindingState === SessionStates.FAILED)
    ) {
      const resumed = await this.tryResumeSession(routeDecision, hydrated);
      if (resumed?.bindingState === SessionStates.ACTIVE) {
        return resumed;
      }
      return this.recreateSession(routeDecision, resumed ?? hydrated);
    }

    const currentState = hydrated?.state ?? SessionStates.MISSING;
    transitionSession(currentState, SessionStates.CREATING);
    const sessionId = hydrated?.sessionId ?? randomId('session');
    const creating = await this.persistSessionState(routeDecision, {
      sessionId,
      bindingState: SessionStates.CREATING,
      runtimeHandle: hydrated?.runtimeHandle ?? null,
      createdAt: hydrated?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      lastUsedAt: nowIso(),
      lastError: null
    });
    let runtimeHandle;
    try {
      runtimeHandle = await this.runtimeGateway.ensureSession({
        agentId: routeDecision.agentName,
        cwd: routeDecision.resolvedCwd,
        sessionName: routeDecision.conversationKey,
        model: routeDecision.model
      });
    } catch (error) {
      await this.persistFailedSession(routeDecision, creating, error);
      throw error;
    }
    const active = await this.persistSessionState(routeDecision, {
      ...creating,
      bindingState: SessionStates.ACTIVE,
      runtimeHandle,
      updatedAt: nowIso(),
      lastUsedAt: nowIso(),
      lastError: null
    });
    return active;
  }

  async recreateSession(routeDecision, previousSession) {
    const currentState = previousSession.bindingState ?? previousSession.state ?? SessionStates.ACTIVE;
    if (currentState !== SessionStates.RECOVERING) {
      transitionSession(currentState, SessionStates.RECOVERING);
    }
    transitionSession(SessionStates.RECOVERING, SessionStates.RECREATING);
    const sessionId = randomId('session');
    const recreating = await this.persistSessionState(routeDecision, {
      sessionId,
      bindingState: SessionStates.RECREATING,
      runtimeHandle: previousSession.runtimeHandle ?? null,
      turnCount: 0,
      createdAt: previousSession.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      lastUsedAt: nowIso(),
      lastRecoveryAt: nowIso(),
      lastError: null
    });
    let runtimeHandle;
    try {
      runtimeHandle = await this.runtimeGateway.ensureSession({
        agentId: routeDecision.agentName,
        cwd: routeDecision.resolvedCwd,
        sessionName: routeDecision.conversationKey,
        model: routeDecision.model
      });
    } catch (error) {
      await this.persistFailedSession(routeDecision, recreating, error);
      throw error;
    }
    const recreated = await this.persistSessionState(routeDecision, {
      ...recreating,
      bindingState: SessionStates.ACTIVE,
      runtimeHandle,
      updatedAt: nowIso(),
      lastUsedAt: nowIso(),
      lastError: null
    });
    return recreated;
  }

  async resetSessionUnlocked(routeDecision) {
    const existing = await this.stateStore.runtimeBindingStore.get(routeDecision.conversationRef);
    const hydrated = await this.hydrateStoredSession(existing, routeDecision);

    if (hydrated?.runtimeHandle) {
      await this.retireSession(hydrated);
    }

    if (hydrated) {
      return this.recreateSession(routeDecision, hydrated);
    }

    const currentTime = nowIso();
    const sessionId = randomId('session');
    const creating = await this.persistSessionState(routeDecision, {
      sessionId,
      bindingState: SessionStates.CREATING,
      runtimeHandle: null,
      turnCount: 0,
      createdAt: currentTime,
      updatedAt: currentTime,
      lastUsedAt: currentTime,
      lastRecoveryAt: null,
      lastError: null
    });
    let runtimeHandle;
    try {
      runtimeHandle = await this.runtimeGateway.ensureSession({
        agentId: routeDecision.agentName,
        cwd: routeDecision.resolvedCwd,
        sessionName: routeDecision.conversationKey,
        model: routeDecision.model
      });
    } catch (error) {
      await this.persistFailedSession(routeDecision, creating, error);
      throw error;
    }
    const active = await this.persistSessionState(routeDecision, {
      ...creating,
      bindingState: SessionStates.ACTIVE,
      runtimeHandle,
      updatedAt: nowIso(),
      lastUsedAt: nowIso(),
      lastError: null
    });
    return active;
  }

  async executeTurn(session, inboundMessage, routeDecision, options = {}) {
    const request = createRuntimeRequest({
      agentId: routeDecision.agentName,
      sessionId: session.sessionId,
      runtimeHandle: session.runtimeHandle,
      cwd: routeDecision.resolvedCwd,
      approvalMode: routeDecision.approvalMode,
      model: routeDecision.model,
      messageText: inboundMessage.rawMeta?.runtimeMessageText ?? inboundMessage.text,
      metadata: { conversationKey: routeDecision.conversationKey },
      onChunk: options.onChunk
    });
    return this.runtimeGateway.runTurn(request);
  }

  async runTurnUnlocked({ inboundMessage, routeDecision, onChunk }) {
    const session = await this.getOrCreateSession(routeDecision);
    let activeSession = session;
    let result = await this.executeTurn(activeSession, inboundMessage, routeDecision, { onChunk });

    if (shouldRecreateSession(result)) {
      activeSession = await this.recreateSession(routeDecision, activeSession);
      result = await this.executeTurn(activeSession, inboundMessage, routeDecision, { onChunk });
    }

    activeSession = {
      ...activeSession,
      bindingState: result.ok || !shouldRecreateSession(result)
        ? SessionStates.ACTIVE
        : SessionStates.FAILED,
      turnCount: Number(activeSession.turnCount ?? 0) + 1,
      updatedAt: nowIso(),
      lastUsedAt: nowIso(),
      lastError: result.ok
        ? null
        : {
            code: result.errorCode ?? null,
            message: result.errorMessage ?? null,
            layer: 'runtime'
          }
    };
    await this.stateStore.runtimeBindingStore.set(routeDecision.conversationRef, activeSession);
    return { session: activeSession, result };
  }

  async runTurn({ inboundMessage, routeDecision, onChunk }) {
    return this.enqueueConversationTask(routeDecision.conversationKey, () =>
      this.runTurnUnlocked({ inboundMessage, routeDecision, onChunk })
    );
  }

  async resetSession(routeDecision) {
    return this.enqueueConversationTask(routeDecision.conversationKey, () =>
      this.resetSessionUnlocked(routeDecision)
    );
  }
}
