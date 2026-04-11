export function createAgentDescriptor(id, config) {
  return Object.freeze({
    id,
    driver: config.driver,
    agent: config.agent,
    cwd: config.cwd,
    sessionNamePrefix: config.sessionNamePrefix,
    approvalMode: config.approvalMode
  });
}
