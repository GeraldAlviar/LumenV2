// Bump the build for *all* modules in a release. Both peers must agree before
// measuring. The HTML/module URLs are versioned too, to avoid mixed deployments.
export const BUILD = '2.2.0';
export const PROTOCOL = 3;
export const REQUEST_MS = 5000;
export const MAX_RETRIES = 2;
export const PRESETS = [
  { id: 'general', name: 'General use', target: 'gamma22' },
  { id: 'gaming', name: 'Gaming (SDR)', target: 'gamma22' },
  { id: 'photo', name: 'Photo / web (sRGB tone curve)', target: 'srgb' },
  { id: 'video', name: 'Video (SDR, dim room)', target: 'rec709' },
];
export const STAGES = {
  idle: 'Ready', review: 'Your choice', preflight: 'Checking camera', starting: 'Connecting test',
  rendering: 'Displaying patch', settling: 'Letting camera settle',
  sampling: 'Sampling', checking: 'Checking reading', saving: 'Saving reading',
  retrying: 'Retrying patch', diagnostics: 'Additional checks',
  paused: 'Test paused', stopped: 'Test stopped', complete: 'Test complete',
};
export function isIPhoneSafari(nav = globalThis.navigator) {
  const ua = nav?.userAgent || '';
  return /iPhone/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}
export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return 'Estimating...';
  const n = Math.max(0, Math.ceil(seconds));
  return n < 60 ? `~${n}s` : `~${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s`;
}
