export class StateStore {
  constructor({ dataDir, runtimeBindingStore, conversationLog }) {
    this.dataDir = dataDir;
    this.runtimeBindingStore = runtimeBindingStore;
    this.conversationLog = conversationLog;
  }
}
