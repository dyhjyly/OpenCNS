/**
 * OpenCNS Cognitive Bus
 *
 * Central registry of cognitive modules.
 */

export class CognitiveBus {
  private modules = new Map<string, unknown>();

  register(name: string, module: unknown) {
    this.modules.set(name, module);
  }

  get(name: string) {
    return this.modules.get(name);
  }
}
