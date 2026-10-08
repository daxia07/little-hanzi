import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateExistingCredentialInput,
  validatePasswordInput,
} from '../lib/pilot/policy.ts';

test('[H-AC-003][U-01] an issued short credential is accepted for sign-in/current-password verification', () => {
  assert.equal(validateExistingCredentialInput('seed'), 'seed');
  assert.equal(validateExistingCredentialInput(''), null);
  assert.equal(validateExistingCredentialInput('x'.repeat(129)), null);
});

test('[H-AC-003][U-02] newly issued or replacement passwords retain the eight-character minimum', () => {
  assert.equal(validatePasswordInput('seed'), null);
  assert.equal(validatePasswordInput('fixture8'), 'fixture8');
  assert.equal(validatePasswordInput('x'.repeat(129)), null);
});
