import { CrewlineError } from '../../shared/errors/error-envelope.js';
import { ErrorCodes } from '../../shared/errors/error-codes.js';

export class AgentRegistry {
  constructor(agentConfig) {
    this.providers = new Map(Object.entries(agentConfig.providers ?? {}));
    this.instances = new Map(Object.entries(agentConfig.instances ?? {}));
  }

  getInstance(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new CrewlineError({
        code: ErrorCodes.ROUTE_AGENT_NOT_FOUND,
        layer: 'core',
        recoverable: false,
        message: `Agent instance not found: ${instanceId}`
      });
    }
    const provider = this.providers.get(instance.providerId);
    if (!provider) {
      throw new CrewlineError({
        code: ErrorCodes.ROUTE_AGENT_NOT_FOUND,
        layer: 'core',
        recoverable: false,
        message: `Agent provider not found: ${instance.providerId}`
      });
    }
    return {
      instanceId,
      providerId: instance.providerId,
      driver: provider.driver,
      agent: provider.agent,
      cwd: instance.cwd,
      sessionNamePrefix: instance.sessionNamePrefix ?? `crewline-${instanceId}`,
      approvalMode: instance.approvalMode ?? 'default'
    };
  }
}
