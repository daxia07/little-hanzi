import test from 'node:test';
import assert from 'node:assert/strict';

import { homeRouteForPilotMode, pilotModeEnabled } from '../lib/pilot-entry.ts';

test('[S2-AC-009][U-01] configured pilot mode sends the root entry to the authenticated pilot', () => {
  assert.equal(pilotModeEnabled('1'), true);
  assert.equal(homeRouteForPilotMode('1'), '/pilot');
  assert.equal(homeRouteForPilotMode(true), '/pilot');
});

test('[S2-AC-009][U-02] an unconfigured local runtime keeps the anonymous legacy entry', () => {
  assert.equal(pilotModeEnabled(undefined), false);
  assert.equal(homeRouteForPilotMode(undefined), 'legacy');
  assert.equal(homeRouteForPilotMode('0'), 'legacy');
  assert.equal(homeRouteForPilotMode('false'), 'legacy');
});

test('[S2-AC-010][U-01] pilot mode accepts only explicit deployment values', () => {
  for (const value of ['true', 'yes']) {
    assert.equal(pilotModeEnabled(value), true, value);
    assert.equal(homeRouteForPilotMode(value), '/pilot', value);
  }
  for (const value of ['', 'on', 'TRUE ', '1 ']) {
    assert.equal(pilotModeEnabled(value), false, value);
    assert.equal(homeRouteForPilotMode(value), 'legacy', value);
  }
});
