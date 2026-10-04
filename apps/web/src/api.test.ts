import { describe, expect, it } from 'vitest';
import { screenshotMetadataFromHeaders } from './api';

describe('screenshotMetadataFromHeaders', () => {
  it('reads screenshot response metadata', () => {
    const headers = new Headers({
      'x-screenshot-width': '780',
      'x-screenshot-height': '1688',
      'x-screenshot-viewport-width': '390',
      'x-screenshot-viewport-height': '844',
      'x-screenshot-device-scale-factor': '2',
      'x-screenshot-full-page': 'false',
      'x-screenshot-duration-ms': '321',
    });
    expect(screenshotMetadataFromHeaders(headers)).toEqual({
      width: 780,
      height: 1688,
      viewportWidth: 390,
      viewportHeight: 844,
      deviceScaleFactor: 2,
      fullPage: false,
      durationMs: 321,
    });
  });
});
