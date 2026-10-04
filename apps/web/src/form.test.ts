import { describe, expect, it } from 'vitest';
import { screenshotPayloadFromForm } from './form';

describe('screenshotPayloadFromForm', () => {
  it('uses a preset without leaking custom values', () => {
    expect(screenshotPayloadFromForm({
      url: ' https://example.com ',
      viewport: 'mobile',
      width: '1440',
      height: '900',
      deviceScaleFactor: '2',
      fullPage: true,
    })).toEqual({ url: 'https://example.com', preset: 'mobile', fullPage: true });
  });

  it('creates a custom viewport payload', () => {
    expect(screenshotPayloadFromForm({
      url: 'https://example.com',
      viewport: 'custom',
      width: '1280',
      height: '720',
      deviceScaleFactor: '1.5',
      fullPage: false,
    })).toEqual({ url: 'https://example.com', width: 1280, height: 720, deviceScaleFactor: 1.5, fullPage: false });
  });

  it('rejects incomplete custom values before sending the request', () => {
    expect(() => screenshotPayloadFromForm({
      url: 'https://example.com',
      viewport: 'custom',
      width: 'abc',
      height: '720',
      deviceScaleFactor: '1',
      fullPage: false,
    })).toThrow('Bredd');
  });
});
