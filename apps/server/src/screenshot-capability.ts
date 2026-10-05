import { ScreenshotResourceController } from './resource-controls.js';
import {
  normalizeScreenshotRequest,
  type NormalizedScreenshotRequest,
  type ScreenshotResult,
} from './screenshot-service.js';

export interface ScreenshotExecutionController {
  run(actorKey: string, request: NormalizedScreenshotRequest): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

/**
 * Canonical application boundary for creating screenshots.
 *
 * Transport adapters (REST/MCP) should depend on this capability rather than
 * browser/resource-control details. The capability owns request normalization
 * and delegates actor-aware runtime resource policy to the shared controller.
 */
export interface ScreenshotCapability {
  capture(actorKey: string, input: unknown): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

export class DefaultScreenshotCapability implements ScreenshotCapability {
  constructor(
    private readonly resources: ScreenshotExecutionController = new ScreenshotResourceController(),
  ) {}

  async capture(actorKey: string, input: unknown): Promise<ScreenshotResult> {
    const request = normalizeScreenshotRequest(input);
    return this.resources.run(actorKey, request);
  }

  close(): Promise<void> {
    return this.resources.close();
  }
}
